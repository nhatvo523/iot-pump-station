# Payload samples

- `telemetry.json`: one normal P01-running sample. LT01/PT01/FT01 are measured values; the running simulator adds sensor noise.
- `event.json` and `event-cleared.json`: activation and clearing of HIGH_LEVEL. `threshold` remains the activation threshold (85), even when clearing at <=80.
- `control-commands.json`: catalogue of scenario/manual commands, not a single MQTT payload. Publish only one entry from `payloads` to `plant/ps01/control`, QoS 1, retain false.

Telemetry/event timestamps are fixed documentation examples, not live readings. Do not publish them unchanged to the live ingest/database as test data.

Normal inlet is 40 m3/h; low_level inlet is 25. Unblocked outlets are P01=40, P02=25, both=50, stopped=0. Inlet may be reduced by overflow/recovery control; it must not be raised above the scenario supply to hold a level. At maximum high-pressure blockage, outlet becomes P01=22, P02=13.75, both=27.5. Level depends on inlet minus outlet.

Normal does not guarantee a return to 60: when inlet and P01 outlet are both 40, the current level stays unchanged, including at 90. Run both pumps (outlet 50) to lower the level with a 40 inlet. Recovery with an already-reduced inlet after a fault/high-pressure scenario is a separate case.

LOW_LEVEL is warning-only. LOW_LOW_LEVEL stops running pumps and latches Run protection until physical level reaches 60 in a scenario other than low_level. LOW_LOW_LEVEL alarm can clear earlier than this interlock. Stop/Run clear a pump Fault, subject to Run protections.

Entering high_pressure preserves pump states. Two already-running pumps remain running. After stopping one, Run is rejected while the other runs. This restriction remains for the whole high_pressure scenario, including after HIGH_PRESSURE clears. Repeating the same fault scenario preserves state; normal/reset still apply.

See `scripts/README.md` for offline scenario checks and live connectivity verification. A sample file alone is not proof that a scenario passes.
