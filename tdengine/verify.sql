-- Run one statement at a time (REST API executes a single statement per request).
SELECT tag_id, COUNT(*) AS n FROM iot_ps.telemetry GROUP BY tag_id;
SELECT ts, tag_id, val, qual FROM iot_ps.telemetry WHERE tag_id = 'LT01' ORDER BY ts DESC LIMIT 5;
SELECT COUNT(*) FROM iot_ps.telemetry WHERE tag_id = 'LT01' AND ts > NOW - 30m;
SELECT ts, asset, pump_state, state_code FROM iot_ps.pump_status ORDER BY ts DESC LIMIT 6;
SELECT ts, alarm_code, severity, is_active, tag_id, val, thr FROM iot_ps.alarm_events ORDER BY ts DESC LIMIT 10;
SELECT ts, scenario, active_alarms FROM iot_ps.station_state ORDER BY ts DESC LIMIT 5;
SELECT TBNAME, COUNT(*) FROM iot_ps.telemetry GROUP BY TBNAME;
SELECT alarm_code, COUNT(*) AS n FROM iot_ps.alarm_events GROUP BY alarm_code;