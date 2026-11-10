-- Schema for PS01 pump station (TDengine 3.x). Idempotent: safe to run many times.
-- Column/tag names avoid TDengine keywords (status, role, tag, value, keep ...).

CREATE DATABASE IF NOT EXISTS iot_ps PRECISION 'ms';

-- Analog sensors: one child table per tag (ps01_lt01, ps01_pt01, ps01_ft01)
CREATE STABLE IF NOT EXISTS iot_ps.telemetry (
  ts TIMESTAMP, val DOUBLE, qual VARCHAR(8)
) TAGS (
  station VARCHAR(16), asset VARCHAR(16), tag_id VARCHAR(16), eng_unit VARCHAR(8)
);

-- Pump states: one child table per pump (ps01_p01_status, ps01_p02_status)
-- state_code: 0 = Stopped, 1 = Running, 2 = Fault
CREATE STABLE IF NOT EXISTS iot_ps.pump_status (
  ts TIMESTAMP, pump_state VARCHAR(12), state_code TINYINT
) TAGS (
  station VARCHAR(16), asset VARCHAR(16), pump_role VARCHAR(12)
);

-- Alarm transitions: one child table per alarm code, so two alarms changing
-- in the same tick can never overwrite each other (same ts).
CREATE STABLE IF NOT EXISTS iot_ps.alarm_events (
  ts TIMESTAMP, severity VARCHAR(12), is_active BOOL, tag_id VARCHAR(16), val DOUBLE, thr DOUBLE
) TAGS (
  station VARCHAR(16), alarm_code VARCHAR(24)
);

-- Scenario + active alarm list per telemetry message (for annotations/overview)
CREATE STABLE IF NOT EXISTS iot_ps.station_state (
  ts TIMESTAMP, scenario VARCHAR(16), active_alarms VARCHAR(80)
) TAGS (
  station VARCHAR(16)
);