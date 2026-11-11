'use strict';

// Offline verification: executes repository Function nodes in isolated contexts.
// No Docker, MQTT publishing, database writes, deployment, or dependencies.
// Usage: node scripts/Verify-Scenarios.js [--report reports/scenarios.json]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const simulatorPath = path.join(root, 'node-red/flows/simulator.json');
const ingestPath = path.join(root, 'node-red/flows/ingest.json');
const nodes = JSON.parse(fs.readFileSync(simulatorPath, 'utf8'));
const ingest = JSON.parse(fs.readFileSync(ingestPath, 'utf8'));
const fingerprint = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const scenarios = ['normal', 'low_level', 'high_pressure', 'pump_fault'];
const codes = ['LOW_LEVEL', 'LOW_LOW_LEVEL', 'HIGH_LEVEL', 'HIGH_HIGH_LEVEL', 'HIGH_PRESSURE', 'PUMP_FAULT'];
const results = [];
const coverage = { ticks: 0, events: 0, telemetryAccepted: 0, eventsAccepted: 0 };
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by more than ${tolerance}`);

function makeHarness() {
  let now = Date.parse('2026-11-11T00:00:00.000Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const state = new Map();
  const flow = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const warnings = [];
  const node = { warn: value => warnings.push(value), status() {}, error: value => { throw Error(value); } };
  const context = vm.createContext({ flow, node, Date: Clock });
  const scripts = Object.fromEntries(['f_init', 'f_ctl', 'f_tick'].map(id => {
    const n = nodes.find(n => n.id === id);
    assert.ok(n, `Missing ${id}`);
    return [id, new vm.Script(`(function(msg) {\n${n.func}\n})(msg)`, { filename: id })];
  }));
  const ingestState = new Map([['schema_ready', true]]);
  const ingestContext = vm.createContext({
    Date: Clock, Buffer,
    flow: { get: key => ingestState.get(key), set: (key, val) => ingestState.set(key, val) },
    node: { warn: value => { throw Error('Ingest rejection: ' + value); }, status() {}, error: value => { throw Error(value); } }
  });
  const normalizers = Object.fromEntries(['f_tele', 'f_evt'].map(id => [id,
    new vm.Script(`(function(msg) {\n${ingest.find(n => n.id === id).func}\n})(msg)`, { filename: id })]));
  const run = (id, payload = {}) => {
    context.msg = { payload };
    return scripts[id].runInContext(context, { timeout: 1000 });
  };
  const normalize = (id, msg) => {
    ingestContext.msg = structuredClone(msg);
    const result = normalizers[id].runInContext(ingestContext, { timeout: 1000 });
    assert.ok(result && typeof result.payload === 'string' && result.payload.startsWith('INSERT INTO '), 'No SQL output');
    if (id === 'f_tele') coverage.telemetryAccepted++; else coverage.eventsAccepted++;
  };
  run('f_init');
  const h = {
    flow, warnings, normalize, messages: [], events: [],
    get s() { return flow.get('sim'); },
    control(payload) { return run('f_ctl', payload); },
    scenario(scenario) { return h.control({ scenario }); },
    pump(pump, command) { return h.control({ pump, command }); },
    tick(count = 1, milliseconds = 2000) {
      let telemetry;
      for (let i = 0; i < count; i++) {
        const previous = { ...h.s.alarms };
        const beforeLevel = h.s.tank.level;
        now += milliseconds;
        const output = run('f_tick');
        assert.ok(output && output.length === 2);
        telemetry = output[0].payload;
        const events = output[1];
        const statuses = Object.values(telemetry.pumps).map(p => p.status);
        const running = statuses.includes('Running');
        assert.equal(telemetry.tags.FT01.value > 0, running, 'Flow/running mismatch');
        assert.equal(telemetry.alarms.includes('PUMP_FAULT'), statuses.includes('Fault'));
        if (telemetry.tags.LT01.value <= 10) assert.equal(running, false, 'Low-low did not stop pumps');
        if (telemetry.tags.LT01.value <= 20) assert.ok(telemetry.alarms.includes('LOW_LEVEL'));
        if (telemetry.tags.PT01.value > 6) assert.ok(telemetry.alarms.includes('HIGH_PRESSURE'));
        assert.ok(scenarios.includes(telemetry.scenario));
        assert.ok(telemetry.alarms.every(code => codes.includes(code)));
        assert.ok(statuses.every(s => ['Running', 'Stopped', 'Fault'].includes(s)));
        assert.equal(Date.parse(telemetry.ts), now);
        assert.ok(telemetry.tags.LT01.value >= 0 && telemetry.tags.LT01.value <= 100);
        assert.ok(telemetry.tags.PT01.value >= 0 && telemetry.tags.PT01.value <= 9);
        assert.ok(telemetry.tags.FT01.value >= 0 && telemetry.tags.FT01.value <= 52);
        assert.ok(h.s.tank.level <= 90 + 1e-9, 'Physical tank exceeded 90%');
        if (beforeLevel <= 90) assert.ok(h.s.inlet.flow <= 40 + 1e-9, 'Inlet exceeded nominal 40');
        const expectedEvents = codes.filter(code => previous[code] !== h.s.alarms[code]);
        assert.deepEqual(Array.from(events, e => e.payload.code).sort(), expectedEvents.sort());
        for (const event of events) {
          assert.equal(event.payload.active, h.s.alarms[event.payload.code]);
          assert.equal(event.payload.ts, telemetry.ts);
          normalize('f_evt', event);
          h.events.push(structuredClone(event.payload));
        }
        normalize('f_tele', output[0]);
        h.messages.push(structuredClone(telemetry));
        coverage.ticks++;
        coverage.events += events.length;
      }
      return telemetry;
    },
    until(predicate, limit = 400) {
      for (let i = 0; i < limit; i++) { h.tick(); if (predicate()) return i + 1; }
      assert.fail(`Condition not reached after ${limit} ticks: ` + JSON.stringify({
        level: h.s.tank.level, inlet: h.s.inlet.flow, outlet: h.s.outlet.flow,
        inletMode: h.s.inlet.mode, limitedFlow: h.s.inlet.limitedFlow,
        pumps: h.s.pumps, interlock: h.s.controller.interlock
      }));
    }
  };
  return h;
}

function test(name, fn, options = {}) {
  try { results.push({ name, status: 'PASS', details: fn() || null, ...options }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message, ...options }); }
  const last = results.at(-1);
  console.log(`[${last.status}] ${name}${last.error ? ': ' + last.error : ''}`);
}

test('Normal: inlet 40, P01 outlet 40, level balanced', () => {
  const h = makeHarness(); const t = h.tick(30);
  near(h.s.tank.level, 60, 1e-8); near(t.tags.FT01.value, 40, 1.5); near(t.tags.PT01.value, 4.2, 0.15);
  assert.equal(h.s.inlet.flow, 40); return { level: h.s.tank.level, flow: t.tags.FT01.value };
});
test('Example telemetry and activation/clearing events are accepted by ingest', () => {
  const h = makeHarness();
  for (const [file, id] of [['telemetry.json', 'f_tele'], ['event.json', 'f_evt'], ['event-cleared.json', 'f_evt']]) {
    const payload = JSON.parse(fs.readFileSync(path.join(root, 'examples', file), 'utf8'));
    h.normalize(id, { payload });
  }
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'examples/control-commands.json'), 'utf8'));
  for (const payload of catalogue.payloads) {
    const isolated = makeHarness();
    assert.ok(isolated.control(payload), 'Example command was rejected: ' + JSON.stringify(payload));
  }
});
test('P02 alone: outlet 25, level rises', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.pump('P02', 'run'); const t = h.tick(20);
  assert.equal(h.s.outlet.flow, 25); near(t.tags.PT01.value, 2.625, 0.15); assert.ok(h.s.tank.level > 60);
  return { level: h.s.tank.level, flow: t.tags.FT01.value, pressure: t.tags.PT01.value };
});
test('Both pumps: outlet 50, level decreases; low warning then low-low trip', () => {
  const h = makeHarness(); h.pump('P02', 'run'); const t = h.tick(20);
  assert.equal(h.s.outlet.flow, 50); assert.ok(h.s.tank.level < 60); near(t.tags.PT01.value, 5.17, 0.15);
  h.until(() => h.s.controller.interlock);
  assert.ok(h.events.some(e => e.code === 'LOW_LEVEL' && e.active));
  assert.ok(h.events.some(e => e.code === 'LOW_LOW_LEVEL' && e.active));
  assert.equal(h.s.pumps.P01.status, 'Stopped'); assert.equal(h.s.pumps.P02.status, 'Stopped');
  return { levelAfter20Ticks: t.tags.LT01.value, tripLevel: h.s.tank.level };
});
test('Both stopped: no outlet, pressure idle, high alarms, anti-overflow at 90', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); const t = h.tick(100);
  assert.equal(h.s.outlet.flow, 0); near(t.tags.PT01.value, 0.2, 0.15); near(h.s.tank.level, 90, 1e-8);
  assert.equal(h.s.inlet.flow, 0);
  assert.ok(h.events.some(e => e.code === 'HIGH_LEVEL' && e.active));
  assert.ok(h.events.some(e => e.code === 'HIGH_HIGH_LEVEL' && e.active));
});
test('At 90: both pumps drain with inlet capped at 40, not balanced at 50', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.tick(50);
  h.pump('P01', 'run'); h.pump('P02', 'run'); h.tick(20);
  assert.equal(h.s.inlet.flow, 40); assert.ok(h.s.tank.level < 85);
  return { level: h.s.tank.level, inlet: h.s.inlet.flow, outlet: h.s.outlet.flow };
});
test('Pump fault auto: standby waits two real seconds, then outlet 25', () => {
  const h = makeHarness(); h.scenario('pump_fault'); h.tick(1, 1000);
  assert.equal(h.s.pumps.P02.status, 'Stopped'); assert.ok(h.s.alarms.PUMP_FAULT);
  h.tick(1, 1000); assert.equal(h.s.pumps.P02.status, 'Running'); assert.equal(h.s.outlet.flow, 25);
});
test('Pump fault -> 90 -> normal: recovery to 60 and inlet restored to 40', () => {
  const h = makeHarness(); h.scenario('pump_fault'); h.until(() => h.s.inlet.mode === 'hold');
  h.scenario('normal'); assert.equal(h.s.inlet.mode, 'recover');
  h.until(() => h.s.inlet.mode === 'normal'); near(h.s.tank.level, 60, 1e-8);
  h.tick(10); assert.equal(h.s.inlet.flow, 40); near(h.s.tank.level, 60, 1e-8);
});
test('High pressure P01: outlet 22, pressure 6.3, tank protected at 90', () => {
  const h = makeHarness(); h.scenario('high_pressure'); const t = h.tick(100);
  near(h.s.outlet.flow, 22, 1e-8); near(t.tags.PT01.value, 6.3, 0.15);
  near(h.s.tank.level, 90, 1e-8); near(h.s.inlet.flow, 22, 1e-8); assert.ok(h.s.alarms.HIGH_PRESSURE);
  return { flow: h.s.outlet.flow, pressure: t.tags.PT01.value, level: h.s.tank.level };
});
test('Entering high pressure preserves both pumps, including while pressure alarm fires', () => {
  const h = makeHarness(); h.pump('P02', 'run'); h.tick(3); h.scenario('high_pressure');
  assert.equal(h.s.pumps.P01.status, 'Running'); assert.equal(h.s.pumps.P02.status, 'Running');
  const t = h.tick(15); assert.ok(h.s.alarms.HIGH_PRESSURE);
  assert.equal(h.s.pumps.P01.status, 'Running'); assert.equal(h.s.pumps.P02.status, 'Running');
  near(h.s.outlet.flow, 27.5, 1e-8); near(t.tags.PT01.value, 7.755, 0.15);
  return { flow: h.s.outlet.flow, pressure: t.tags.PT01.value };
});
test('High pressure: Stop one pump, reject its restart, permit one from both stopped', () => {
  const h = makeHarness(); h.pump('P02', 'run'); h.scenario('high_pressure'); h.tick(10);
  h.pump('P01', 'stop'); const before = JSON.stringify(h.s); assert.equal(h.pump('P01', 'run'), null);
  assert.equal(JSON.stringify(h.s), before); h.tick(3);
  near(h.s.outlet.flow, 13.75, 1e-8); assert.equal(h.s.alarms.HIGH_PRESSURE, false);
  assert.equal(h.pump('P01', 'run'), null, 'Scenario must still restrict Run after pressure alarm clears');
  h.pump('P02', 'stop'); h.tick(5); assert.equal(h.s.outlet.flow, 0);
  assert.ok(h.pump('P01', 'run')); assert.equal(h.pump('P02', 'run'), null);
});
test('High pressure preserves stopped pumps on entry', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.scenario('high_pressure'); h.tick(10);
  assert.equal(h.s.pumps.P01.status, 'Stopped'); assert.equal(h.s.pumps.P02.status, 'Stopped');
});
test('High pressure -> normal: blockage clears, alarms clear, recovery reaches 60', () => {
  const h = makeHarness(); h.scenario('high_pressure'); h.tick(100); h.scenario('normal');
  assert.equal(h.s.outlet.blockage, 0); assert.equal(h.s.pumps.P01.status, 'Running');
  assert.equal(h.s.pumps.P02.status, 'Stopped'); h.until(() => h.s.inlet.mode === 'normal');
  near(h.s.tank.level, 60, 1e-8); h.tick(3); assert.equal(h.s.alarms.HIGH_PRESSURE, false);
  assert.equal(h.s.alarms.HIGH_LEVEL, false); assert.equal(h.s.alarms.HIGH_HIGH_LEVEL, false);
});
test('Low-level with P02 only: inlet 25 balances outlet 25', () => {
  const h = makeHarness(); h.scenario('low_level'); h.pump('P01', 'stop'); h.pump('P02', 'run');
  h.tick(2); const initial = h.s.tank.level; h.tick(30);
  assert.equal(h.s.inlet.flow, 25); assert.equal(h.s.outlet.flow, 25); near(h.s.tank.level, initial, 1e-8);
});
test('Low-level inlet 25; warning permits Run before low-low; low-low rejects Run', () => {
  const h = makeHarness(); h.scenario('low_level'); h.until(() => h.s.alarms.LOW_LEVEL);
  assert.equal(h.s.inlet.flow, 25); assert.equal(h.s.controller.interlock, false);
  h.pump('P01', 'stop'); assert.ok(h.pump('P01', 'run'));
  h.until(() => h.s.controller.interlock); const before = JSON.stringify(h.s);
  assert.equal(h.pump('P01', 'run'), null); assert.equal(JSON.stringify(h.s), before);
  assert.ok(h.pump('P02', 'fault')); assert.ok(h.pump('P02', 'stop'));
});
test('Low-low -> normal: no automatic restart until physical level reaches 60', () => {
  const h = makeHarness(); h.scenario('low_level'); h.until(() => h.s.controller.interlock); h.scenario('normal');
  while (h.s.tank.level < 60) {
    assert.equal(h.s.pumps.P01.status, 'Stopped');
    assert.equal(h.pump('P01', 'run'), null); h.tick();
  }
  assert.equal(h.s.controller.interlock, false); assert.equal(h.s.pumps.P01.status, 'Running');
  return { restartLevel: h.s.tank.level };
});
test('Manual mode: releasing low-low interlock does not automatically restart pumps', () => {
  const h = makeHarness(); h.scenario('low_level'); h.until(() => h.s.controller.interlock);
  h.scenario('normal'); h.pump('P01', 'stop'); h.until(() => !h.s.controller.interlock);
  assert.equal(h.s.pumps.P01.status, 'Stopped'); assert.ok(h.pump('P01', 'run'));
});
test('Manual fault: no standby; Stop and Run each clear Fault', () => {
  const h = makeHarness(); h.pump('P01', 'fault'); h.tick(5);
  assert.equal(h.s.pumps.P02.status, 'Stopped'); assert.equal(h.s.outlet.flow, 0); assert.ok(h.s.alarms.PUMP_FAULT);
  h.pump('P01', 'stop'); h.tick(); assert.equal(h.s.alarms.PUMP_FAULT, false);
  h.pump('P01', 'fault'); h.tick(); h.pump('P01', 'run'); h.tick(); assert.equal(h.s.alarms.PUMP_FAULT, false);
});
test('P02 Fault while P01 runs: main output unchanged, fault alarm published', () => {
  const h = makeHarness(); h.pump('P02', 'fault'); const t = h.tick(10);
  assert.equal(h.s.outlet.flow, 40); near(t.tags.PT01.value, 4.2, 0.15); assert.ok(h.s.alarms.PUMP_FAULT);
});
test('Repeated fault scenario is unchanged; normal and reset restore automatic mode', () => {
  const h = makeHarness(); h.scenario('pump_fault'); h.tick(2); h.pump('P02', 'stop');
  const before = JSON.stringify(h.s); h.scenario('pump_fault'); assert.equal(JSON.stringify(h.s), before);
  h.scenario('normal'); assert.equal(h.s.controller.manual, false); assert.equal(h.s.pumps.P01.status, 'Running');
  h.pump('P01', 'stop'); h.scenario('normal'); assert.equal(h.s.pumps.P01.status, 'Running');
  h.scenario('reset'); near(h.s.tank.level, 60, 1e-8); h.tick(); assert.equal(h.s.alarms.PUMP_FAULT, false);
});
test('Invalid/mixed commands warn and do not mutate state', () => {
  const h = makeHarness();
  for (const payload of [{ pump: 'P03', command: 'run' }, { pump: 'P01', command: 'bogus' },
    { pump: 'P01' }, { command: 'run' }, {}, null, { scenario: 'bad' },
    { scenario: 'normal', pump: 'P01', command: 'run' }]) {
    const before = JSON.stringify(h.s); const warnings = h.warnings.length;
    assert.equal(h.control(payload), null); assert.equal(JSON.stringify(h.s), before); assert.equal(h.warnings.length, warnings + 1);
  }
});
test('Recovery with no outlet cannot overflow; restarting pump continues recovery', () => {
  const h = makeHarness(); h.scenario('pump_fault'); h.until(() => h.s.inlet.mode === 'hold');
  h.scenario('normal'); h.pump('P01', 'stop'); h.tick(100);
  near(h.s.tank.level, 90, 1e-8); assert.equal(h.s.inlet.flow, 0); assert.equal(h.s.inlet.mode, 'recover');
  h.pump('P01', 'run'); h.until(() => h.s.inlet.mode === 'normal'); near(h.s.tank.level, 60, 1e-8);
});
// Probes use only legal operator commands, to expose combinations not covered by isolated scenarios.
test('Normal at 90 with P01 running stays balanced; adding P02 drains to 60', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.tick(50); h.pump('P01', 'run'); h.tick(3);
  h.scenario('normal'); h.tick(20);
  near(h.s.tank.level, 90, 1e-8); assert.equal(h.s.inlet.flow, 40); assert.equal(h.s.outlet.flow, 40);
  assert.ok(h.pump('P02', 'run')); h.until(() => h.s.tank.level <= 60 + 1e-8, 100);
  near(h.s.tank.level, 60, 1e-8); assert.equal(h.s.inlet.flow, 40); assert.equal(h.s.outlet.flow, 50);
  assert.equal(h.s.inlet.mode, 'normal');
}, { kind: 'interaction-probe' });
test('Stop then normal at 90 restores balance; adding P02 drains to 60', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.tick(50); h.pump('P01', 'run'); h.tick(3);
  h.pump('P01', 'stop'); h.scenario('normal');
  h.tick(20); near(h.s.tank.level, 90, 1e-8);
  assert.equal(h.s.pumps.P01.status, 'Running'); assert.equal(h.s.inlet.flow, 40); assert.equal(h.s.outlet.flow, 40);
  assert.ok(h.pump('P02', 'run')); h.until(() => h.s.tank.level <= 60 + 1e-8, 100);
  near(h.s.tank.level, 60, 1e-8); assert.equal(h.s.inlet.mode, 'normal');
}, { kind: 'interaction-probe' });

const summary = { pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length };
const report = {
  checkedAtUtc: new Date().toISOString(), mode: 'offline',
  description: 'Repository function code with fake clock, 2s ticks and x20. No services modified.',
  sources: { simulatorSha256: fingerprint(simulatorPath), ingestSha256: fingerprint(ingestPath) },
  summary, coverage, checks: results,
  limitations: ['Does not deploy Node-RED or validate live MQTT/TDengine/Grafana.',
    'Sensor LT01 includes noise; physical level cap is verified separately from measured LT01.',
    'Failed interaction probes are reported, not silently excluded.']
};
if (process.argv[2] === '--report') {
  if (!process.argv[3]) throw Error('Missing report path');
  const destination = path.resolve(root, process.argv[3]);
  const reportRoot = path.join(root, 'reports') + path.sep;
  if (!destination.startsWith(reportRoot)) throw Error('Report destination must be under reports/');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log('Report: ' + destination);
}
console.log(JSON.stringify({ summary, coverage }));
process.exitCode = summary.fail ? 1 : 0;
