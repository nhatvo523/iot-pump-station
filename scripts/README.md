# Verification tools

Run commands from the repository root. No dependency installation is required: offline checks need Node.js; live checks need Windows PowerShell, Docker Compose and the running project.

## Offline simulator and ingest checks

```powershell
node .\scripts\Verify-Scenarios.js --report reports/scenario-verification.json
```

Executes the actual three simulator Function nodes in isolated in-memory contexts with a fake UTC clock, real 2-second tick intervals and x20 physical time. Tests normal, low-level, high-pressure, pump fault, manual commands, repeated commands, 90% overflow control, 60% recovery and interactions between commands. Every generated telemetry/event goes through the actual ingest normalizers; SQL is generated but never sent to TDengine.

Per-tick checks cover pump states versus flow/fault alarms, low-low stopping, alarm thresholds, event transitions, ranges and physical level <=90. LT01 measurement noise can produce values slightly above 90 even when physical level is protected.

The script publishes nothing, does not deploy flows or access Docker, and writes only the requested report under `reports/`. Exit code is 1 if any check fails. Interaction failures are retained as failures; the script does not alter simulator code to make them pass.

Expected balance: normal with inlet 40 and P01 outlet 40 preserves the current level, even at 90. The interaction checks require adding P02 (total outlet 50) to drain to 60; they do not require normal alone to lower a balanced tank.

## Live connectivity and configuration checks

```powershell
# Optional: set a Grafana service-account token with sufficient read/query rights.
$env:GRAFANA_API_TOKEN = '<your token>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Level1.ps1 -ReportPath .\reports\level1-verification-current.json
Remove-Item Env:\GRAFANA_API_TOKEN
```

Checks services, deployed Function-node hashes against repository files, a live MQTT sample reaching TDengine, schema/history, Grafana datasource/data panels, six rule definitions/health and active-only alert-list configuration. Without a token, authenticated Grafana checks are explicitly skipped. It does not publish scenario commands or prove that every Grafana alert activates and clears during a live scenario. API checks do not prove browser rendering.

Only an explicit `-TestInterruption` option deliberately stops and restarts TDengine. Do not add that option for a read-only check. This checks resumed new data and preservation of old data, not zero-loss backfill; failed INSERTs currently have no durable retry queue.

Reports include timestamps and source hashes. Old reports describe their original run, not necessarily the current simulator. `reports/` is ignored by Git and must not be committed.
