[CmdletBinding()]
param(
    [switch]$TestInterruption,
    [ValidateRange(10, 45)][int]$OutageSeconds = 15,
    [string]$GrafanaToken = $env:GRAFANA_API_TOKEN,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$results = [System.Collections.Generic.List[object]]::new()
$tdHeaders = @{ Authorization = 'Basic cm9vdDp0YW9zZGF0YQ==' }
$grafanaHeaders = @{ Authorization = "Bearer $GrafanaToken" }

function Record([string]$Name, [string]$Status, $Details) {
    $results.Add([pscustomobject]@{ check = $Name; status = $Status; details = $Details })
    Write-Host "[$Status] $Name"
}
function Assert-Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Invoke-Compose([string[]]$DockerArgs) {
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & docker compose @DockerArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($exitCode -ne 0) { throw "docker compose failed: $output" }
    return @($output | ForEach-Object { $_.ToString() })
}
function Invoke-Sql([string]$Sql) {
    $response = Invoke-RestMethod -Uri 'http://localhost:6041/rest/sql' -Method Post `
        -Headers $tdHeaders -ContentType 'text/plain' -Body $Sql -TimeoutSec 5
    Assert-Check ($response.code -eq 0) ("TDengine error: " + $response.desc)
    return $response
}
function Get-Latest {
    $r = Invoke-Sql 'SELECT ts, val FROM iot_ps.ps01_lt01 ORDER BY ts DESC LIMIT 1'
    Assert-Check ($r.rows -eq 1) 'No telemetry stored; import and deploy both Node-RED flows first.'
    return [pscustomobject]@{ timestamp = [DateTimeOffset]::Parse($r.data[0][0]); value = $r.data[0][1] }
}
function Wait-LatestAfter([DateTimeOffset]$After, [int]$TimeoutSeconds = 90) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $last = Get-Latest
            if ($last.timestamp -gt $After -and ([DateTimeOffset]::UtcNow - $last.timestamp).TotalSeconds -lt 15) { return $last }
        } catch { Write-Verbose $_ }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'Fresh telemetry did not resume before timeout.'
}
function Invoke-Grafana([string]$Path, $Body = $null) {
    $options = @{ Uri = "http://localhost:3001$Path"; Headers = $grafanaHeaders; TimeoutSec = 15 }
    if ($null -ne $Body) {
        $options.Method = 'Post'
        $options.ContentType = 'application/json'
        $options.Body = $Body | ConvertTo-Json -Depth 40 -Compress
    }
    return Invoke-RestMethod @options
}
function Check-GrafanaData([DateTimeOffset]$MinimumTimestamp, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($GrafanaToken)) {
        Record $Label 'SKIP' 'Set GRAFANA_API_TOKEN to validate Grafana datasource queries; UI verification is still required.'
        return
    }
    $health = Invoke-Grafana '/api/datasources/uid/tdengine-ps01/health'
    Assert-Check ($health.status -eq 'OK') 'Grafana datasource health failed.'
    $dashboard = Invoke-Grafana '/api/dashboards/uid/ps01-monitoring'
    $targets = @($dashboard.dashboard.panels | Where-Object id -eq 1)[0].targets
    $now = [DateTimeOffset]::UtcNow
    $response = Invoke-Grafana '/api/ds/query' @{
        from = [string]$now.AddMinutes(-5).ToUnixTimeMilliseconds()
        to = [string]$now.ToUnixTimeMilliseconds()
        queries = @($targets)
    }
    Assert-Check (-not $response.results.A.error) 'Grafana query returned an error.'
    $frames = @($response.results.A.frames)
    Assert-Check ($frames.Count -gt 0) 'Grafana returned no frames.'
    $timestamp = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$frames[0].data.values[0][0])
    Assert-Check ($timestamp -ge $MinimumTimestamp) 'Grafana still shows an older sample.'
    Record $Label 'PASS' @{ datasource = $health.status; sampleUtc = $timestamp.ToString('o'); value = $frames[0].data.values[1][0] }
}

Push-Location $projectRoot
try {
    $null = Invoke-Compose @('config', '--quiet')
    $running = @(Invoke-Compose @('ps', '--status', 'running', '--services'))
    foreach ($service in @('mosquitto', 'nodered', 'tdengine', 'grafana')) {
        Assert-Check ($running -contains $service) "Service not running: $service"
    }
    Record 'Compose services' 'PASS' ($running -join ', ')

    $raw = Invoke-Compose @('exec', '-T', 'mosquitto', 'mosquitto_sub', '-t', 'plant/ps01/telemetry', '-C', '1', '-W', '10')
    $message = ($raw -join "`n") | ConvertFrom-Json
    $mqttTimestamp = [DateTimeOffset]::Parse($message.ts)
    Assert-Check ($message.station -eq 'PS01') 'Unexpected MQTT station.'
    Assert-Check ([Math]::Abs(([DateTimeOffset]::UtcNow - $mqttTimestamp).TotalSeconds) -lt 15) 'MQTT telemetry is stale.'
    foreach ($tag in @('LT01', 'PT01', 'FT01')) {
        Assert-Check ($null -ne $message.tags.$tag.value) "Missing MQTT sensor $tag"
    }
    Record 'Live MQTT JSON' 'PASS' @{ timestamp = $message.ts; scenario = $message.scenario }
    $stored = Wait-LatestAfter ($mqttTimestamp.AddMilliseconds(-1)) 15
    $exactSample = Invoke-Sql ("SELECT COUNT(*) FROM iot_ps.telemetry WHERE ts = " + $mqttTimestamp.ToUnixTimeMilliseconds())
    Assert-Check ($exactSample.data[0][0] -eq 3) 'The captured MQTT message did not produce all three sensor rows.'
    Record 'MQTT reaches TDengine' 'PASS' $stored

    $schema = Invoke-Sql 'SHOW iot_ps.stables'
    $names = @($schema.data | ForEach-Object { $_[0] })
    Assert-Check ($names.Count -eq 4) 'Expected exactly four supertables.'
    foreach ($name in @('telemetry', 'pump_status', 'station_state', 'alarm_events')) {
        Assert-Check ($names -contains $name) "Missing supertable $name"
    }
    Record 'TDengine schema' 'PASS' $names

    $history = Invoke-Sql 'SELECT FIRST(ts), LAST(ts), COUNT(*) FROM iot_ps.ps01_lt01'
    $first = [DateTimeOffset]::Parse($history.data[0][0])
    $last = [DateTimeOffset]::Parse($history.data[0][1])
    Assert-Check (($last - $first).TotalMinutes -ge 30) 'B4 requires at least 30 minutes of stored history.'
    $counts = Invoke-Sql 'SELECT tag_id, COUNT(*) FROM iot_ps.telemetry WHERE ts > NOW - 30m GROUP BY tag_id'
    Assert-Check ($counts.rows -eq 3) 'Expected recent history for all three sensors.'
    Record 'At least 30 minutes history' 'PASS' @{ firstUtc = $first.ToString('o'); lastUtc = $last.ToString('o'); samples = $history.data[0][2]; recentCounts = $counts.data }

    foreach ($line in Get-Content 'tdengine/verify.sql') {
        if ($line.Trim() -and -not $line.Trim().StartsWith('--')) { $null = Invoke-Sql $line }
    }
    Record 'All verify.sql queries' 'PASS' '8 queries executed successfully.'
    $grafanaHealth = Invoke-RestMethod 'http://localhost:3001/api/health' -TimeoutSec 10
    Assert-Check ($grafanaHealth.database -eq 'ok') 'Grafana health failed.'
    Record 'Grafana service health' 'PASS' $grafanaHealth.version
    Check-GrafanaData $stored.timestamp 'Grafana live query'

    if ($TestInterruption) {
        $before = Get-Latest
        $outageStart = [DateTimeOffset]::UtcNow
        $restartNeeded = $true
        try {
            Write-Host "Stopping only TDengine for $OutageSeconds seconds; volumes and other containers are kept."
            $null = Invoke-Compose @('stop', '-t', '10', 'tdengine')
            $unavailable = $false
            try { $null = Invoke-Sql 'SHOW iot_ps.stables' } catch { $unavailable = $true }
            Assert-Check $unavailable 'TDengine should be unreachable during the interruption.'
            Start-Sleep -Seconds $OutageSeconds
            $during = Invoke-Compose @('exec', '-T', 'mosquitto', 'mosquitto_sub', '-t', 'plant/ps01/telemetry', '-C', '1', '-W', '10')
            $duringMessage = ($during -join "`n") | ConvertFrom-Json
            Assert-Check ([DateTimeOffset]::Parse($duringMessage.ts) -gt $before.timestamp) 'MQTT stopped during database interruption.'
            Record 'TDengine interrupted; MQTT continues' 'PASS' @{ beforeUtc = $before.timestamp.ToString('o'); mqttDuringUtc = $duringMessage.ts }
        } finally {
            if ($restartNeeded) {
                Write-Host 'Starting TDengine again (automatic cleanup).'
                $null = Invoke-Compose @('start', 'tdengine')
            }
        }
        $restartAt = [DateTimeOffset]::UtcNow
        $resumed = Wait-LatestAfter $restartAt 90
        $recoverySeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $restartAt).TotalSeconds, 1)
        $old = Invoke-Sql ("SELECT COUNT(*) FROM iot_ps.ps01_lt01 WHERE ts = " + $before.timestamp.ToUnixTimeMilliseconds())
        Assert-Check ($old.data[0][0] -eq 1) 'Previously stored sample was lost.'
        $null = Invoke-Sql 'SHOW iot_ps.stables'
        Record 'TDengine resumes without redeploy; old data retained' 'PASS' @{
            interruptedAtUtc = $outageStart.ToString('o'); restartedAtUtc = $restartAt.ToString('o');
            recoveredSampleUtc = $resumed.timestamp.ToString('o'); recoverySeconds = $recoverySeconds
            limitation = 'Failed INSERTs are not retried. Data/events during downtime may be lost.'
        }
        Check-GrafanaData $restartAt 'Grafana query after recovery'
    } else {
        Record 'Deliberate interruption' 'SKIP' 'Run with -TestInterruption to demonstrate B6 recovery.'
    }
} catch {
    Record 'Verification' 'FAIL' $_.Exception.Message
    throw
} finally {
    if ($ReportPath) {
        $absoluteReport = [System.IO.Path]::GetFullPath($ReportPath)
        $parent = Split-Path -Parent $absoluteReport
        $null = New-Item -ItemType Directory -Path $parent -Force
        $report = @{ checkedAtUtc = [DateTimeOffset]::UtcNow.ToString('o'); interruptionRequested = [bool]$TestInterruption; checks = $results.ToArray() }
        [System.IO.File]::WriteAllText($absoluteReport, ($report | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
        Write-Host "Report: $absoluteReport"
    }
    Pop-Location
}
