import assert from 'node:assert/strict';
import test from 'node:test';
import { environment, names, toolCall, TOOL_NAME, PREFIX, READ, OPEN, CLOSE, BLOCKED, GUARDED } from './runtime-helpers.js';

const fixture = async (t, body, options) => {
  const e = await environment(options);
  t.after(() => e.close());
  await body(e);
};
const magpie = request => names(request).filter(name => name.startsWith(PREFIX));

// Deliberately inspect only adapter requests for visibility assertions. Calling
// schemas()/assemble() ourselves (or controller.refresh()) would hide timing bugs.

test('real AgentLoop: a host plugin enabled after Agent creation masks its first request', { timeout: 10000 }, t => fixture(t, async e => {
  const first = await e.makeAgent();
  const second = await e.makeAgent();
  await e.installHostPlugin();
  for (const agent of [first, second]) {
    const requests = await e.run(agent, [null]);
    assert.deepEqual(magpie(requests[0]), [], 'bootstrap must cover every already-published Agent');
    assert.ok(names(requests[0]).includes(TOOL_NAME));
  }
}, { lateHostPlugin: true }));

test('real AgentLoop: unloading a host plugin releases its masks before removing the projection', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  const fiber = await e.installHostPlugin();
  agent.ctx.tools.restrict({ deny: [BLOCKED] });
  agent.ctx.tools.guard(exec => exec.name === GUARDED ? 'guard survives unload' : undefined);
  await e.run(agent, [toolCall(TOOL_NAME, { names: [READ] }), toolCall(READ), null]);
  const removals = [], warnings = [];
  e.root.logger.exporter({ export(message) {
    if (message.type === 'error' || message.type === 'warn') warnings.push(message.args.map(String).join(' '));
  } });
  let present = true;
  const stopObserving = e.root.on('tools/change', () => {
    const next = e.root.tools.get(TOOL_NAME, agent) !== undefined;
    if (present && !next) removals.push({ projectionPresent: e.state(agent) !== undefined });
    present = next;
  });
  try {
    await fiber.dispose();
    assert.deepEqual(removals, [{ projectionPresent: true }]);
    assert.equal(e.state(agent), undefined);
    assert.deepEqual(warnings, [], 'ordered disposal must not swallow listener/projection errors');
    const requests = await e.run(agent, [toolCall(READ), toolCall(GUARDED), null]);
    assert.ok(names(requests[0]).includes(READ));
    assert.ok(!names(requests[0]).includes(BLOCKED), 'external deny survives discovery unload');
    assert.ok(!names(requests[0]).includes(TOOL_NAME));
    assert.equal(e.calls.at(-1).name, READ);
    assert.match(JSON.stringify(e.results(agent).at(-1)), /guard survives unload/);
    assert.deepEqual(warnings, [], 'later committed tool/results cannot call into the disposed projection');
    assert.equal(e.state(agent), undefined, 'later requests cannot recreate the disposed projection');
  } finally { stopObserving(); }
}, { lateHostPlugin: true }));

test('real AgentLoop: blank standard Agent selects donh-dev before its first request', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent('standard');
  await e.root.agentPresets.select(agent, 'donh-dev');
  const requests = await e.run(agent, [null]);
  assert.deepEqual(magpie(requests[0]), [], 'the first assembled model request must hide all original Magpie tools');
  assert.ok(names(requests[0]).includes(TOOL_NAME));
}));

test('real AgentLoop: exact discovery loads the original tool in the immediately adjacent request', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  const requests = await e.run(agent, [toolCall(TOOL_NAME, { names: [READ] }), toolCall(READ), null]);
  assert.deepEqual(magpie(requests[0]), []);
  assert.deepEqual(magpie(requests[1]), [READ], 'request 2 must include the tool loaded by request 1');
  assert.equal(requests.length, 3, 'lookup, immediate original call, then completion; no buffer step');
  assert.equal(e.root.tools.get(READ, agent), e.originals.get(READ));
  assert.deepEqual(e.calls.map(call => call.name), [READ]);
  assert.ok(e.results(agent).every(result => result.data.message.isError === false));
}));

test('real AgentLoop: loading close_session closes on the adjacent request without another open', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  const requests = await e.run(agent, [
    toolCall(TOOL_NAME, { names: [OPEN] }), toolCall(OPEN),
    toolCall(TOOL_NAME, { names: [CLOSE] }), toolCall(CLOSE), null,
  ]);
  assert.ok(names(requests[3]).includes(CLOSE), 'the request directly following close discovery must contain close_session');
  assert.deepEqual(e.counts(), { open: 1, close: 1 });
  assert.deepEqual(e.calls.map(call => call.name), [OPEN, CLOSE]);
  assert.ok(e.results(agent).every(result => result.data.message.isError === false));
}));

const lookupValue = event => JSON.parse(event.data.message.content[0].text);
const delta = value => ({ added: value.added, evicted: value.evicted, unchanged: value.unchanged });

test('real AgentLoop: replacement changes the adjacent request, keeps cleanup and preserves external deny/guard', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  agent.ctx.tools.restrict({ deny: [BLOCKED] });
  agent.ctx.tools.guard(exec => exec.name === GUARDED ? 'external replacement guard' : undefined);
  const requests = await e.run(agent, [
    toolCall(TOOL_NAME, { names: [READ, OPEN, CLOSE] }),
    toolCall(TOOL_NAME, { names: [CLOSE, BLOCKED, GUARDED], replace: true }),
    toolCall(GUARDED), toolCall(CLOSE), toolCall(READ), null,
  ]);
  assert.deepEqual(magpie(requests[1]).sort(), [READ, OPEN, CLOSE].sort());
  for (const request of requests.slice(2)) {
    assert.deepEqual(magpie(request).sort(), [CLOSE, GUARDED].sort());
    assert.ok(!names(request).includes(BLOCKED), 'external deny remains authoritative');
  }
  assert.deepEqual(e.state(agent).selected, [CLOSE, BLOCKED, GUARDED], 'externally denied names remain in the selected set');
  assert.equal(e.root.tools.get(CLOSE, agent), e.originals.get(CLOSE));
  assert.deepEqual(e.calls.map(call => call.name), [CLOSE], 'replacement only selects, and the guard still prevents execution');
  assert.deepEqual(e.counts(), { open: 0, close: 1 });
  const results = e.results(agent);
  const replaced = lookupValue(results[1]);
  assert.equal(replaced.action, 'replace');
  assert.deepEqual(delta(replaced), { added: [BLOCKED, GUARDED], evicted: [READ, OPEN], unchanged: [CLOSE] });
  assert.match(JSON.stringify(results[2]), /external replacement guard/);
  assert.equal(results[4].data.message.isError, true);
  assert.match(JSON.stringify(results[4]), /UNKNOWN_TOOL/);
}));

test('real AgentLoop: unavailable or conflicting replacements retain the committed selection on every adjacent request', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  const previous = [READ, CLOSE];
  const requests = await e.run(agent, [
    toolCall(TOOL_NAME, { names: previous }),
    toolCall(TOOL_NAME, { names: [OPEN, `${PREFIX}fixture__unavailable`, CLOSE], replace: true }),
    toolCall(TOOL_NAME, { names: [OPEN], replace: true, offset: 0 }),
    toolCall(TOOL_NAME, {}), toolCall(CLOSE), null,
  ]);
  for (const request of requests.slice(1)) assert.deepEqual(magpie(request).sort(), previous.toSorted());
  assert.deepEqual(e.state(agent).selected, previous);
  assert.deepEqual(e.state(agent).pending, []);
  assert.deepEqual(e.calls.map(call => call.name), [CLOSE]);
  const results = e.results(agent);
  assert.equal(results[1].data.message.isError, true);
  assert.match(JSON.stringify(results[1]), /Unavailable Magpie tool names/);
  assert.equal(results[2].data.message.isError, true);
  assert.match(JSON.stringify(results[2]), /replace applies to names only/);
  assert.deepEqual(delta(lookupValue(results[3])), { added: [], evicted: [], unchanged: previous });
}));

test('real AgentLoop: reloading and replacement reorder without false evictions, then reset reports the complete delta', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  const requests = await e.run(agent, [
    toolCall(TOOL_NAME, { names: [READ, CLOSE] }),
    toolCall(TOOL_NAME, { names: [READ], replace: false }),
    toolCall(TOOL_NAME, { names: [READ, CLOSE], replace: true }),
    toolCall(TOOL_NAME, { reset: true }), null,
  ]);
  for (const request of requests.slice(1, 4)) assert.deepEqual(magpie(request).sort(), [READ, CLOSE].sort());
  assert.deepEqual(magpie(requests[4]), []);
  const results = e.results(agent).map(lookupValue);
  assert.deepEqual(delta(results[0]), { added: [READ, CLOSE], evicted: [], unchanged: [] });
  assert.deepEqual(delta(results[1]), { added: [], evicted: [], unchanged: [CLOSE, READ] });
  assert.deepEqual(delta(results[2]), { added: [], evicted: [], unchanged: [READ, CLOSE] });
  assert.deepEqual(delta(results[3]), { added: [], evicted: [READ, CLOSE], unchanged: [] });
  assert.deepEqual(e.calls, [], 'discovery never executes an original tool');
  const definition = e.root.tools.get(TOOL_NAME, agent);
  assert.equal(definition.parameters.properties.replace.type, 'boolean');
  assert.ok(definition.output.schema.properties.action.enum.includes('replace'));
  for (const field of ['added', 'evicted', 'unchanged']) {
    assert.ok(definition.output.schema.required.includes(field));
    assert.deepEqual(definition.output.schema.properties[field], { type: 'array', items: { type: 'string' } });
    for (const value of results) {
      assert.ok(value[field].length <= 12);
      assert.equal(new Set(value[field]).size, value[field].length);
    }
  }
}));

test('real AgentLoop: replacement restores from native results and remains isolated from a second Agent', { timeout: 10000 }, t => fixture(t, async e => {
  const original = await e.makeAgent();
  const second = await e.makeAgent();
  await e.run(second, [toolCall(TOOL_NAME, { names: [OPEN] }), null]);
  await e.run(original, [
    toolCall(TOOL_NAME, { names: [READ, OPEN] }),
    toolCall(TOOL_NAME, { names: [CLOSE], replace: true }), null,
  ]);
  const seed = structuredClone(e.logs.get(original.id));
  const restored = await e.makeAgent('donh-dev', seed);
  const restoredRequests = await e.run(restored, [toolCall(CLOSE), null]);
  assert.deepEqual(magpie(restoredRequests[0]), [CLOSE]);
  assert.deepEqual(e.state(restored).selected, [CLOSE]);
  assert.deepEqual(e.state(original).selected, [CLOSE]);
  const secondRequests = await e.run(second, [toolCall(OPEN), null]);
  assert.deepEqual(magpie(secondRequests[0]), [OPEN]);
  assert.deepEqual(e.state(second).selected, [OPEN]);
  assert.deepEqual(e.calls.map(call => call.name), [CLOSE, OPEN]);
}));

test('real preset registry: blank Agent exits donh-dev and first standard request releases its mask', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  await e.root.agentPresets.select(agent, 'standard');
  const requests = await e.run(agent, [toolCall(READ), null]);
  assert.ok(names(requests[0]).includes(READ));
  assert.ok(!names(requests[0]).includes(TOOL_NAME));
  assert.deepEqual(e.calls.map(call => call.name), [READ]);
}));

test('real preset registry: blank Agent exits and reenters before first request without lag', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  await e.root.agentPresets.select(agent, 'standard');
  await e.root.agentPresets.select(agent, 'donh-dev');
  const requests = await e.run(agent, [toolCall(TOOL_NAME, { names: [READ] }), toolCall(READ), null]);
  assert.deepEqual(magpie(requests[0]), []);
  assert.deepEqual(magpie(requests[1]), [READ]);
  assert.deepEqual(e.calls.map(call => call.name), [READ]);
}));

test('real preset registry: retained revisions with the same id keep independent request masks', { timeout: 10000 }, t => fixture(t, async e => {
  const older = await e.makeAgent();
  await e.run(older, [toolCall(TOOL_NAME, { names: [READ] }), toolCall(READ), null]);
  const olderDefinition = e.root.tools.get(TOOL_NAME, older);
  await e.replacePresetRevision();
  const newer = await e.makeAgent();
  assert.notEqual(e.root.tools.get(TOOL_NAME, newer), olderDefinition, 'test must retain two distinct plugin instances');
  const newerRequests = await e.run(newer, [toolCall(TOOL_NAME, { names: [OPEN] }), toolCall(OPEN), null]);
  assert.deepEqual(magpie(newerRequests[0]), []);
  assert.deepEqual(magpie(newerRequests[1]), [OPEN]);
  const olderRequests = await e.run(older, [toolCall(READ), null]);
  assert.deepEqual(magpie(olderRequests[0]), [READ]);
  assert.equal(e.root.tools.get(TOOL_NAME, older), olderDefinition);
  assert.deepEqual(e.state(older).selected, [READ]);
  assert.deepEqual(e.state(newer).selected, [OPEN]);
}));

test('real AgentLoop: selecting the entire catalog and resetting handles an empty deny without dropping other policies', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  const all = [READ, OPEN, CLOSE, BLOCKED, GUARDED];
  agent.ctx.tools.restrict({ deny: ['mcp__other__read'] });
  const warnings = [];
  e.root.logger.exporter({ export(message) {
    if (message.type === 'error' || message.type === 'warn') warnings.push(message.args.map(String).join(' '));
  } });
  const requests = await e.run(agent, [
    toolCall(TOOL_NAME, { names: all }), toolCall(READ), toolCall(TOOL_NAME, { reset: true }), null,
  ]);
  assert.deepEqual(magpie(requests[1]).sort(), all.sort());
  assert.deepEqual(magpie(requests[3]), []);
  assert.deepEqual(e.state(agent).selected, []);
  assert.deepEqual(e.calls.map(call => call.name), [READ]);
  for (const request of requests) assert.ok(!names(request).includes('mcp__other__read'));
  assert.deepEqual(warnings, [], 'empty discovery deny must not issue a restriction error');
}));

test('real AgentLoop: newly initialized Agents have independent cold first requests', { timeout: 10000 }, t => fixture(t, async e => {
  const first = await e.makeAgent();
  await e.run(first, [toolCall(TOOL_NAME, { names: [READ] }), toolCall(READ), null]);
  const second = await e.makeAgent();
  const requests = await e.run(second, [null]);
  assert.deepEqual(magpie(requests[0]), []);
  assert.deepEqual(e.state(second).selected, []);
  assert.deepEqual(e.state(first).selected, [READ]);
}));

test('real AgentLoop: replayed committed selection is present on a restored Agent first request', { timeout: 10000 }, t => fixture(t, async e => {
  const original = await e.makeAgent();
  await e.run(original, [toolCall(TOOL_NAME, { names: [READ] }), toolCall(READ), null]);
  const seed = structuredClone(e.logs.get(original.id));
  const restored = await e.makeAgent('donh-dev', seed);
  const requests = await e.run(restored, [toolCall(READ), null]);
  assert.deepEqual(magpie(requests[0]), [READ]);
  assert.deepEqual(e.state(restored).selected, [READ]);
  assert.equal(e.calls.at(-1).agent, restored);
  assert.equal(e.results(restored).at(-1).data.message.isError, false);
}));

test('real AgentLoop: native image definitions retain identity and remain immediately callable', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  for (const name of ['generate_image', 'edit_image']) {
    assert.equal(e.root.tools.get(name, agent), e.originals.get(name));
  }
  const requests = await e.run(agent, [toolCall('generate_image'), toolCall('edit_image'), null]);
  for (const request of requests) {
    assert.deepEqual(magpie(request), []);
    for (const name of ['generate_image', 'edit_image', 'mcp__other__read']) assert.ok(names(request).includes(name));
  }
  assert.deepEqual(e.calls.map(call => call.name), ['generate_image', 'edit_image']);
  for (const event of e.results(agent)) {
    assert.equal(event.data.message.isError, false);
    assert.equal(event.data.message.content.at(-1).text, 'original finalizer');
    assert.equal(event.data.meta.original, true);
  }
}));

test('real AgentLoop: inherited deny and execution guard stay authoritative after discovery', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  agent.ctx.tools.restrict({ deny: [BLOCKED] });
  agent.ctx.tools.guard(exec => exec.name === GUARDED ? 'external fixture guard' : undefined);
  const requests = await e.run(agent, [
    toolCall(TOOL_NAME, { names: [BLOCKED, GUARDED] }),
    toolCall(BLOCKED), toolCall(GUARDED), null,
  ]);
  assert.ok(!names(requests[1]).includes(BLOCKED));
  assert.ok(names(requests[1]).includes(GUARDED));
  assert.deepEqual(e.calls, [], 'neither denied nor guarded original stub may execute');
  const results = e.results(agent);
  assert.equal(results[1].data.message.isError, true);
  assert.match(JSON.stringify(results[1]), /UNKNOWN_TOOL/);
  assert.equal(results[2].data.message.isError, true);
  assert.match(JSON.stringify(results[2]), /external fixture guard/);
}));

test('real AgentLoop: denying magpie_tools does not release the cold original-tool mask', { timeout: 10000 }, t => fixture(t, async e => {
  const agent = await e.makeAgent();
  agent.ctx.tools.restrict({ deny: [TOOL_NAME] });
  const requests = await e.run(agent, [toolCall(READ), null]);
  for (const request of requests) {
    assert.deepEqual(magpie(request), []);
    assert.ok(!names(request).includes(TOOL_NAME));
  }
  assert.deepEqual(e.calls, []);
  assert.equal(e.results(agent)[0].data.message.isError, true);
  assert.match(JSON.stringify(e.results(agent)[0]), /UNKNOWN_TOOL/);
}));
