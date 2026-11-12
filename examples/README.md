# Payload samples

Two JSON files contain the examples used by the offline verification script:

| File | Contents | Usage |
| --- | --- | --- |
| `payloads.json` | `telemetry`: one normal P01-running sample; `events`: HIGH_LEVEL activation and clearing | Read each object separately; the wrapper is not a simulator MQTT message. |
| `control-commands.json` | Scenario commands, three independent-cause disable commands, and manual pump commands | Publish one object from `payloads` to `plant/ps01/control`, QoS 1, retain false. |

Telemetry/event timestamps are fixed documentation examples, not live readings. Do not publish them unchanged to the live database. In both event examples, `threshold` is the activation threshold (85), including the clearing event at <=80.

Fault commands enable causes cumulatively. Use `active: false` to disable one cause; `normal` clears all causes, while `reset` also resets physical state. Full behavior, flow values, timing and protection rules are maintained in the [project README](../README.md), rather than duplicated here.

See [verification tools](../scripts/README.md) to check the examples and simulator. A sample file alone is not proof that a scenario passes.
