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
  let now = Date.parse('2026-11-09T08:00:00.000Z');
  let stoppedTicks = 0, runningTicks = 0;
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
    trigger(scenario, active = true) { return h.control({ scenario, active }); },
    pump(pump, command) { return h.control({ pump, command }); },
    tick(count = 1, milliseconds = 2000) {
      let telemetry;
      for (let i = 0; i < count; i++) {
        const previous = { ...h.s.alarms };
        const beforeLevel = h.s.tank.level;
        const beforeFlow = h.s.outlet.flow;
        now += milliseconds;
        const output = run('f_tick');
        assert.ok(output && output.length === 2);
        telemetry = output[0].payload;
        const events = output[1];
        const statuses = Object.values(telemetry.pumps).map(p => p.status);
        const running = statuses.includes('Running');
        stoppedTicks = running ? 0 : stoppedTicks + 1;
        runningTicks = running ? runningTicks + 1 : 0;
        // Inertia permits residual flow after stopping. Check the physical flow,
        // not noisy FT01, for monotonic decay; zero must be exact by the configured decay deadline (at most ten 2s ticks).
        if (!running) {
          assert.ok(h.s.outlet.flow <= beforeFlow + 1e-9, 'Stopped flow increased');
          const deadline = Math.ceil(h.flow.get('simConfig').dynamics.flowTauDown * Math.log(52 / 0.5) / 2);
          if (stoppedTicks >= deadline) assert.equal(telemetry.tags.FT01.value, 0);
        } else if (runningTicks >= 2) assert.ok(telemetry.tags.FT01.value > 0);
        assert.equal(telemetry.alarms.includes('PUMP_FAULT'), statuses.includes('Fault'));
        if (telemetry.tags.LT01.value <= 10) assert.equal(running, false, 'Low-low did not stop pumps');
        if (telemetry.tags.LT01.value <= 20) assert.ok(telemetry.alarms.includes('LOW_LEVEL'));
        if (telemetry.tags.PT01.value > 6) assert.ok(telemetry.alarms.includes('HIGH_PRESSURE'));
        assert.ok(scenarios.includes(telemetry.scenario));
        assert.ok(telemetry.alarms.every(code => codes.includes(code)));
        assert.ok(statuses.every(s => ['Running', 'Stopped', 'Fault'].includes(s)));
        assert.equal(h.s.simulation.triggers.pump_fault, telemetry.pumps.P01.status === 'Fault');
        near(h.s.simulation.inflowFactor, h.s.simulation.triggers.low_level ? 25 / 40 : 1, 1e-10);
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
  const samples = JSON.parse(fs.readFileSync(path.join(root, 'examples/payloads.json'), 'utf8'));
  h.normalize('f_tele', { payload: samples.telemetry });
  assert.equal(samples.events.length, 2, 'Expected activation and clearing samples');
  assert.equal(samples.events[0].active, true);
  assert.equal(samples.events[1].active, false);
  assert.equal(samples.events[0].code, samples.events[1].code);
  for (const payload of samples.events) h.normalize('f_evt', { payload });
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'examples/control-commands.json'), 'utf8'));
  for (const payload of catalogue.payloads) {
    const isolated = makeHarness();
    // Exercise disable commands against an active cause, not an already-off no-op.
    if (payload.active === false) {
      assert.ok(isolated.scenario(payload.scenario));
      assert.equal(isolated.s.simulation.triggers[payload.scenario], true);
    }
    assert.ok(isolated.control(payload), 'Example command was rejected: ' + JSON.stringify(payload));
    if (payload.active === false) assert.equal(isolated.s.simulation.triggers[payload.scenario], false);
  }
});
test('P02 alone: outlet 25, level rises', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.pump('P02', 'run'); const t = h.tick(20);
  near(h.s.outlet.flow, 25, 0.001); near(t.tags.PT01.value, 2.625, 0.15); assert.ok(h.s.tank.level > 60);
  return { level: h.s.tank.level, flow: t.tags.FT01.value, pressure: t.tags.PT01.value };
});
test('Both pumps: outlet 50, level decreases; low warning then low-low trip', () => {
  const h = makeHarness(); h.pump('P02', 'run'); const t = h.tick(20);
  near(h.s.outlet.flow, 50, 0.1); assert.ok(h.s.tank.level < 60); near(t.tags.PT01.value, 5.17, 0.15);
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
test('Pump fault auto: standby waits four real seconds, then flow settles at 25', () => {
  const h = makeHarness(); h.scenario('pump_fault'); h.tick(1, 1000);
  assert.equal(h.s.pumps.P02.status, 'Stopped'); assert.ok(h.s.alarms.PUMP_FAULT);
  h.tick(1, 2000); assert.equal(h.s.pumps.P02.status, 'Stopped');
  h.tick(1, 1000); assert.equal(h.s.pumps.P02.status, 'Running');
  h.tick(40); near(h.s.outlet.flow, 25, 0.001);
});
test('Pump fault -> 90 -> normal: recovery to 60 and inlet restored to 40', () => {
  const h = makeHarness(); h.scenario('pump_fault'); h.until(() => h.s.inlet.mode === 'hold');
  h.scenario('normal'); assert.equal(h.s.inlet.mode, 'recover');
  h.until(() => h.s.inlet.mode === 'normal'); near(h.s.tank.level, 60, 1e-8);
  h.tick(10); assert.equal(h.s.inlet.flow, 40); near(h.s.tank.level, 60, 0.05);
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
  const t = h.tick(60); assert.ok(h.s.alarms.HIGH_PRESSURE);
  assert.equal(h.s.pumps.P01.status, 'Running'); assert.equal(h.s.pumps.P02.status, 'Running');
  near(h.s.outlet.flow, 27.5, 0.001); near(t.tags.PT01.value, 7.755, 0.15);
  return { flow: h.s.outlet.flow, pressure: t.tags.PT01.value };
});
test('High pressure: Stop one pump, reject its restart, permit one from both stopped', () => {
  const h = makeHarness(); h.pump('P02', 'run'); h.scenario('high_pressure'); h.tick(40);
  h.pump('P01', 'stop'); const before = JSON.stringify(h.s); assert.equal(h.pump('P01', 'run'), null);
  assert.equal(JSON.stringify(h.s), before); h.tick(20);
  near(h.s.outlet.flow, 13.75, 0.002); assert.equal(h.s.alarms.HIGH_PRESSURE, false);
  assert.equal(h.pump('P01', 'run'), null, 'Scenario must still restrict Run after pressure alarm clears');
  h.pump('P02', 'stop'); h.tick(10); assert.equal(h.s.outlet.flow, 0);
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
  h.tick(20); const initial = h.s.tank.level; h.tick(30);
  assert.equal(h.s.inlet.flow, 25); near(h.s.outlet.flow, 25, 0.001); near(h.s.tank.level, initial, 0.001);
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
  const h = makeHarness(); h.pump('P01', 'fault'); h.tick(10);
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
test('Normal at 90 with settled P01 stays balanced; adding P02 drains to 60', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.tick(50); h.pump('P01', 'run'); h.tick(80);
  h.scenario('normal'); h.tick(20);
  near(h.s.tank.level, 90, 1e-6); near(h.s.inlet.flow, 40, 1e-6); near(h.s.outlet.flow, 40, 1e-6);
  assert.ok(h.pump('P02', 'run')); h.until(() => h.s.tank.level <= 60 + 1e-8, 100);
  // Continuous manual draining crosses 60; it does not stop the pumps there.
  near(h.s.tank.level, 60, 10 * 40 / 3600 / 0.2); assert.equal(h.s.inlet.flow, 40); near(h.s.outlet.flow, 50, 1e-5);
  assert.equal(h.s.inlet.mode, 'normal');
}, { kind: 'interaction-probe' });
test('Stop then normal at 90 with settled outlet restores balance; adding P02 drains to 60', () => {
  const h = makeHarness(); h.pump('P01', 'stop'); h.tick(50); h.pump('P01', 'run'); h.tick(80);
  h.pump('P01', 'stop'); h.scenario('normal');
  h.tick(20); near(h.s.tank.level, 90, 1e-6);
  assert.equal(h.s.pumps.P01.status, 'Running'); near(h.s.inlet.flow, 40, 1e-6); near(h.s.outlet.flow, 40, 1e-6);
  assert.ok(h.pump('P02', 'run')); h.until(() => h.s.tank.level <= 60 + 1e-8, 100);
  near(h.s.tank.level, 60, 10 * 40 / 3600 / 0.2); assert.equal(h.s.inlet.mode, 'normal');
}, { kind: 'interaction-probe' });

// Dynamic curves use real seconds. Every tick also checks protections, event
// transitions and compatibility with the real ingest normalizers above.
const warm = () => { const h = makeHarness(); h.tick(20); return h; };
const sample = h => {
  const t = h.tick();
  return { flow: h.s.outlet.flow, pressure: h.s.outlet.pressure,
    ft: t.tags.FT01.value, pt: t.tags.PT01.value };
};
const monotonic = (values, direction, tolerance = 1e-9) => {
  for (let i = 1; i < values.length; i++) {
    assert.ok(direction * (values[i] - values[i - 1]) >= -tolerance,
      `Non-monotonic series: ${values}`);
  }
};

test('Slow pump fault: shallow flow dip, gradual pressure decline, standby at four seconds', () => {
  const h = warm(); h.scenario('pump_fault');
  const curve = Array.from({ length: 12 }, () => sample(h));
  assert.ok(curve[0].flow > 20 && curve[0].flow < 40);
  // At the second tick P02 starts; the initial dip must already be visible.
  assert.equal(h.messages.at(-12).pumps.P02.status, 'Stopped');
  assert.equal(h.messages.at(-11).pumps.P02.status, 'Running');
  assert.ok(curve[0].pressure > 2.625 && curve[0].pressure < 4.2, 'Slow decay need not undershoot standby pressure');
  monotonic(curve.map(v => v.flow), 1);
  monotonic(curve.map(v => v.ft), 1, 1);
  monotonic(curve.map(v => v.pressure), -1);
  near(curve.at(-1).flow, 25, 25 * 0.05);
  near(curve.at(-1).pressure, 2.625, 2.625 * 0.05);
  near(curve.at(-1).ft, 25, 25 * 0.05);
  near(curve.at(-1).pt, 2.625, 2.625 * 0.05);
  return { firstTick: curve[0], after24Seconds: curve.at(-1) };
});
test('Slow stop: residual flow decays to exact zero within ten ticks, no pressure undershoot', () => {
  const observations = [];
  for (const both of [false, true]) {
    const h = warm();
    if (both) { h.pump('P02', 'run'); h.tick(20); }
    h.pump('P01', 'stop'); h.pump('P02', 'stop');
    const curve = Array.from({ length: 24 }, () => sample(h));
    monotonic(curve.map(v => v.flow), -1);
    monotonic(curve.map(v => v.ft), -1, 1);
    monotonic(curve.map(v => v.pressure), -1);
    assert.ok(curve[3].flow > 0, 'Expected longer residual flow');
    assert.equal(curve[9].ft, 0);
    assert.ok(curve.every(v => v.pt >= 0.1));
    near(curve.at(-1).pressure, 0.2, 0.002);
    observations.push({ both, firstTenFlows: curve.slice(0, 10).map(v => v.ft) });
  }
  return observations;
});
test('Smooth both-pump start: monotonic flow and pressure, no physical overshoot', () => {
  const h = warm(); h.pump('P02', 'run');
  const curve = Array.from({ length: 12 }, () => sample(h));
  monotonic(curve.map(v => v.flow), 1);
  monotonic(curve.map(v => v.pressure), 1);
  monotonic(curve.map(v => v.ft), 1, 1);
  monotonic(curve.map(v => v.pt), 1, 0.1);
  assert.ok(curve.every(v => v.flow <= 50 && v.pressure <= 5.17));
  assert.ok(curve.every(v => v.ft < 50 * 1.03 && v.pt < 5.17 * 1.03));
  near(curve.at(-1).flow, 50, 0.05 * 50);
  return { firstTick: curve[0], after24Seconds: curve.at(-1) };
});
test('Smooth high pressure: sixty-second blockage ramp, alarm at 50-70 seconds with P01', () => {
  const h = warm(); h.scenario('high_pressure');
  const curve = Array.from({ length: 60 }, () => sample(h));
  monotonic(curve.map(v => v.flow), -1);
  monotonic(curve.map(v => v.pressure), 1);
  // A longer settled tail has independent sensor noise, not a monotonic trend.
  monotonic(curve.slice(0, 30).map(v => v.ft), -1, 1);
  monotonic(curve.slice(0, 30).map(v => v.pt), 1, 0.1);
  for (const point of curve) { near(point.ft, point.flow, 1.5); near(point.pt, point.pressure, 0.15); }
  assert.ok(curve[0].pressure < 4.5, 'First tick must not jump to 6.3');
  near(h.s.outlet.blockage, 0.5, 1e-9);
  const fired = h.events.find(e => e.code === 'HIGH_PRESSURE' && e.active);
  assert.ok(fired);
  const seconds = (Date.parse(fired.ts) - Date.parse(h.messages[19].ts)) / 1000;
  assert.ok(seconds >= 50 && seconds <= 70);
  near(curve.at(-1).flow, 22, 0.001); near(curve.at(-1).pressure, 6.3, 0.001);
  return { alarmSeconds: seconds, firstTick: curve[0], after120Seconds: curve.at(-1) };
});
test('Dynamics use elapsed real time independent of x20, including irregular tick intervals', () => {
  const a = warm(), b = warm();
  b.flow.get('simConfig').timeScale = 1;
  a.scenario('high_pressure'); b.scenario('high_pressure');
  for (const milliseconds of [500, 1500, 3000, 1000, 2000]) {
    a.tick(1, milliseconds); b.tick(1, milliseconds);
    near(a.s.outlet.flow, b.s.outlet.flow, 1e-10);
    near(a.s.outlet.pressure, b.s.outlet.pressure, 1e-10);
    near(a.s.outlet.blockage, b.s.outlet.blockage, 1e-10);
  }
  near(60 - b.s.tank.level, (60 - a.s.tank.level) / 20, 1e-9);
  const h = warm(); h.pump('P02', 'run'); h.tick(1, 1000);
  near(h.s.outlet.flow, 40 + 10 * (1 - Math.exp(-1 / 8)), 1e-10);
  near(h.s.outlet.pressure, 4.2 + 0.97 * (1 - Math.exp(-1 / 8)), 1e-10);
});
test('Smooth return to normal: outlet recovers gradually and pressure alarm clears by hysteresis', () => {
  const h = warm(); h.scenario('high_pressure'); h.tick(60);
  assert.ok(h.s.alarms.HIGH_PRESSURE);
  h.scenario('normal');
  const curve = Array.from({ length: 12 }, () => sample(h));
  assert.ok(curve[0].flow > 22 && curve[0].flow < 40);
  assert.ok(curve[0].pressure > 4.2 && curve[0].pressure < 6.3);
  monotonic(curve.map(v => v.flow), 1);
  monotonic(curve.map(v => v.pressure), -1);
  near(curve.at(-1).flow, 40, 0.05 * 40);
  near(curve.at(-1).pressure, 4.2, 0.05 * 4.2);
  assert.equal(h.s.alarms.HIGH_PRESSURE, false);
  assert.ok(h.events.some(e => e.code === 'HIGH_PRESSURE' && !e.active));
});
test('Low-low trip stops pump states immediately while residual flow decays safely', () => {
  const h = warm(); h.scenario('low_level'); h.until(() => h.s.controller.interlock);
  assert.equal(h.s.pumps.P01.status, 'Stopped');
  assert.equal(h.s.pumps.P02.status, 'Stopped');
  assert.ok(h.s.outlet.flow > 0, 'Expected inertial flow immediately after safety stop');
  const before = JSON.stringify(h.s);
  assert.equal(h.pump('P01', 'run'), null);
  assert.equal(JSON.stringify(h.s), before);
  h.tick(10); assert.equal(h.s.outlet.flow, 0);
  assert.equal(h.s.controller.interlock, true);
});

// All combinations use real operator commands and retain the same ingest contract.
for (const both of [false, true]) {
  for (const blockage of [false, true]) {
    for (const low of [false, true]) {
      for (const fault of [false, true]) {
        test(`Independent causes: both=${both}, blockage=${blockage}, lowInlet=${low}, P01Fault=${fault}`, () => {
          const h = warm();
          // Isolate settled operating points from x20 tank trips; safety is tested separately.
          h.flow.get('simConfig').timeScale = 1;
          if (both) { h.pump('P02', 'run'); h.tick(10); }
          if (blockage) h.scenario('high_pressure');
          if (low) h.scenario('low_level');
          if (fault) h.scenario('pump_fault');
          h.tick(64);
          assert.equal(h.s.simulation.triggers.high_pressure, blockage);
          assert.equal(h.s.simulation.triggers.low_level, low);
          assert.equal(h.s.simulation.triggers.pump_fault, fault);
          assert.equal(h.s.pumps.P01.status, fault ? 'Fault' : 'Running');
          assert.equal(h.s.pumps.P02.status, both || fault ? 'Running' : 'Stopped');
          const baseFlow = fault ? 25 : both ? 50 : 40;
          const basePressure = fault ? 2.625 : both ? 5.17 : 4.2;
          const expectedFlow = baseFlow * (blockage ? 0.55 : 1);
          near(h.s.outlet.flow, expectedFlow, 0.002);
          near(h.s.outlet.pressure, basePressure * (blockage ? 1.5 : 1), 0.002);
          const nominalInlet = low ? 25 : 40;
          // Assess slope after settling, not the net change during blockage ramp.
          // With inlet 25 and P01, level initially falls before outlet drops below 25.
          const settled = h.s.tank.level; h.tick(2);
          if (nominalInlet > expectedFlow) assert.ok(h.s.tank.level >= settled - 1e-8);
          else if (nominalInlet < expectedFlow) assert.ok(h.s.tank.level < settled);
          else near(h.s.tank.level, settled, 0.001);
          return { flow: h.s.outlet.flow, pressure: h.s.outlet.pressure, level: h.s.tank.level };
        });
      }
    }
  }
}
test('Independent triggers accumulate in every activation order; repeats preserve timers, ramp and manual mode', () => {
  const orders = [
    ['low_level', 'high_pressure', 'pump_fault'], ['low_level', 'pump_fault', 'high_pressure'],
    ['high_pressure', 'low_level', 'pump_fault'], ['high_pressure', 'pump_fault', 'low_level'],
    ['pump_fault', 'low_level', 'high_pressure'], ['pump_fault', 'high_pressure', 'low_level']
  ];
  for (const order of orders) {
    const h = warm();
    for (const trigger of order) { assert.ok(h.scenario(trigger)); h.tick(3); }
    assert.ok(Object.values(h.s.simulation.triggers).every(Boolean));
    assert.equal(h.s.simulation.scenario, order.at(-1));
    h.pump('P02', 'stop');
    const before = JSON.stringify(h.s);
    for (const trigger of order) assert.ok(h.trigger(trigger));
    assert.equal(JSON.stringify(h.s), before);
    h.tick(5); assert.equal(h.s.pumps.P02.status, 'Stopped');
  }
});
test('Disable one cause without clearing others; high-pressure Run restriction uses flag, not summary scenario', () => {
  const h = warm(); h.pump('P02', 'run');
  h.scenario('high_pressure'); h.scenario('low_level'); h.tick(25);
  assert.equal(h.s.simulation.scenario, 'low_level');
  h.pump('P01', 'stop'); assert.equal(h.pump('P01', 'run'), null);
  const blockage = h.s.outlet.blockage;
  h.trigger('low_level', false);
  assert.equal(h.s.simulation.inflowFactor, 1); assert.equal(h.s.outlet.blockage, blockage);
  assert.equal(h.s.simulation.triggers.high_pressure, true);
  h.trigger('high_pressure', false); h.tick(20);
  assert.equal(h.s.outlet.blockage, 0); assert.equal(h.s.simulation.scenario, 'normal');
  assert.ok(h.pump('P01', 'run'));
});
test('Disable P01 fault preserves P02, blockage and reduced inlet; manual Run/Stop also clear P01 cause', () => {
  const h = warm(); h.scenario('low_level'); h.scenario('high_pressure'); h.scenario('pump_fault'); h.tick(10);
  const blockage = h.s.outlet.blockage;
  h.trigger('pump_fault', false);
  assert.equal(h.s.pumps.P01.status, 'Stopped'); assert.equal(h.s.pumps.P02.status, 'Running');
  assert.equal(h.s.outlet.blockage, blockage); near(h.s.simulation.inflowFactor, 25 / 40, 1e-10);
  h.tick(); assert.equal(h.s.alarms.PUMP_FAULT, false);
  h.trigger('pump_fault'); h.pump('P01', 'stop');
  assert.equal(h.s.simulation.triggers.pump_fault, false);
  h.trigger('pump_fault'); h.pump('P02', 'stop'); assert.ok(h.pump('P01', 'run'));
  assert.equal(h.s.simulation.triggers.pump_fault, false);
  assert.equal(h.s.simulation.triggers.low_level, true); assert.equal(h.s.simulation.triggers.high_pressure, true);
  h.tick(); assert.equal(h.s.alarms.PUMP_FAULT, false);
});
test('Faulting P01 while both run preserves P02 without another standby wait', () => {
  const h = warm(); h.pump('P02', 'run'); h.tick(10);
  h.scenario('pump_fault'); assert.equal(h.s.pumps.P02.status, 'Running');
  h.tick(); assert.equal(h.s.pumps.P02.status, 'Running');
  assert.ok(h.s.alarms.PUMP_FAULT);
});
test('Reduced inlet stays active through low-low refill; auto restarts at 60 and can trip again', () => {
  const h = warm(); h.scenario('low_level'); h.until(() => h.s.controller.interlock);
  h.until(() => !h.s.controller.interlock);
  assert.ok(h.s.tank.level >= 60); assert.equal(h.s.pumps.P01.status, 'Running');
  assert.equal(h.s.simulation.triggers.low_level, true); near(h.s.simulation.inflowFactor, 25 / 40, 1e-10);
  h.until(() => h.s.controller.interlock);
  assert.equal(h.events.filter(e => e.code === 'LOW_LOW_LEVEL' && e.active).length, 2);
});
test('Manual mode keeps pumps stopped after refill to 60 even with reduced inlet still active', () => {
  const h = warm(); h.scenario('low_level'); h.pump('P01', 'run');
  h.until(() => h.s.controller.interlock); h.until(() => !h.s.controller.interlock);
  assert.ok(h.s.tank.level >= 60); assert.equal(h.s.controller.manual, true);
  assert.equal(h.s.pumps.P01.status, 'Stopped'); assert.equal(h.s.pumps.P02.status, 'Stopped');
  assert.equal(h.s.simulation.triggers.low_level, true);
  assert.ok(h.pump('P01', 'run')); h.tick(2); assert.ok(h.s.outlet.flow > 0);
});
test('All causes plus low-low: no standby before 60; release starts healthy P02 through blockage', () => {
  const h = warm(); h.scenario('low_level'); h.until(() => h.s.controller.interlock);
  h.scenario('pump_fault'); h.scenario('high_pressure'); h.tick(10);
  assert.equal(h.s.pumps.P01.status, 'Fault'); assert.equal(h.s.pumps.P02.status, 'Stopped');
  assert.equal(h.pump('P02', 'run'), null);
  h.until(() => !h.s.controller.interlock);
  assert.ok(h.s.tank.level >= 60); assert.equal(h.s.pumps.P02.status, 'Running');
  h.tick(40); near(h.s.outlet.flow, 13.75, 0.002); near(h.s.outlet.pressure, 3.9375, 0.002);
  assert.equal(h.s.alarms.HIGH_PRESSURE, false);
  h.tick(50); near(h.s.tank.level, 90, 1e-8);
});
test('Low warning -> normal -> high pressure: inlet restored, low alarm clears by level, not command', () => {
  const h = warm(); h.scenario('low_level'); h.until(() => h.s.alarms.LOW_LEVEL);
  h.scenario('normal'); h.scenario('high_pressure');
  assert.equal(h.s.alarms.LOW_LEVEL, true); assert.equal(h.s.controller.interlock, false);
  assert.equal(h.s.simulation.triggers.low_level, false);
  assert.equal(h.s.pumps.P01.status, 'Running');
  h.tick(60); assert.equal(h.s.inlet.flow, 40); assert.equal(h.s.alarms.LOW_LEVEL, false);
  assert.equal(h.s.alarms.HIGH_PRESSURE, true);
});
test('Low-low -> normal -> high pressure: latch holds to 60, then P01 restarts into blockage', () => {
  const h = warm(); h.scenario('low_level'); h.until(() => h.s.controller.interlock);
  h.scenario('normal'); h.scenario('high_pressure'); h.tick(10);
  assert.equal(h.s.pumps.P01.status, 'Stopped'); assert.equal(h.s.pumps.P02.status, 'Stopped');
  assert.equal(h.pump('P01', 'run'), null); assert.equal(h.s.alarms.HIGH_PRESSURE, false);
  h.until(() => !h.s.controller.interlock);
  assert.ok(h.s.tank.level >= 60); assert.equal(h.s.pumps.P01.status, 'Running');
  h.tick(40); near(h.s.outlet.flow, 22, 0.002); assert.equal(h.s.alarms.HIGH_PRESSURE, true);
});
test('Normal/reset clear all causes; reset retains alarm flags until clear events are published', () => {
  for (const command of ['normal', 'reset']) {
    const h = warm(); h.scenario('low_level'); h.scenario('high_pressure'); h.scenario('pump_fault'); h.tick(30);
    assert.ok(h.s.alarms.PUMP_FAULT);
    const before = h.events.length;
    h.scenario(command);
    assert.ok(Object.values(h.s.simulation.triggers).every(v => v === false));
    assert.equal(h.s.controller.manual, false); assert.equal(h.s.outlet.blockage, 0);
    assert.equal(h.s.pumps.P01.status, 'Running'); assert.equal(h.s.pumps.P02.status, 'Stopped');
    h.tick();
    assert.ok(h.events.slice(before).some(e => e.code === 'PUMP_FAULT' && !e.active));
  }
});
test('Invalid trigger flags and mixed commands reject atomically, without clearing active causes', () => {
  const h = warm(); h.scenario('high_pressure');
  for (const payload of [{ scenario: 'low_level', active: 'false' }, { scenario: 'pump_fault', active: 1 },
    { scenario: 'high_pressure', active: null }, { scenario: 'normal', active: false },
    { scenario: 'reset', active: true }, { active: false },
    { pump: 'P01', command: 'stop', active: false }]) {
    const before = JSON.stringify(h.s), warnings = h.warnings.length;
    assert.equal(h.control(payload), null); assert.equal(JSON.stringify(h.s), before);
    assert.equal(h.warnings.length, warnings + 1);
  }
});

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
