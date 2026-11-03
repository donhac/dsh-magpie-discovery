import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_NAME,
  PREFIX,
  META_TAG,
  MAX_LOADED,
  MAX_BATCH,
  parseRequest,
  rank,
  lookup,
  initialState,
  foldSelection,
  parseProjectionState,
  validSelection
} from '../discovery-core.js';

const N = name => `${PREFIX}fixture__${name}`;
const catalog = [
  { name: N('browser_tabs'), description: 'List browser tabs' },
  { name: N('dbx_execute_query'), description: 'Run a database query with DBX' },
  { name: N('github_get_file_contents'), description: 'Read a GitHub repository file' },
  { name: N('taptap_create_app'), description: 'Create a TapTap mini game' }
];

test('parseRequest accepts the documented forms', () => {
  assert.deepEqual(parseRequest({}), { action: 'status', query: undefined, names: undefined, limit: 3, offset: 0 });
  assert.equal(parseRequest({ query: ' browser ' }).query, 'browser');
  assert.equal(parseRequest({ names: [N('browser_tabs')] }).action, 'load');
  assert.equal(parseRequest({ reset: true }).action, 'reset');
});

test('parseRequest rejects conflicts and malformed values', () => {
  assert.throws(() => parseRequest({ query: 'browser', names: [N('browser_tabs')] }), /separately/);
  assert.throws(() => parseRequest({ query: '' }), /1–160/);
  assert.throws(() => parseRequest({ query: 'browser', limit: 0 }), /limit/);
  assert.throws(() => parseRequest({ query: 'browser', offset: -1 }), /offset/);
  assert.throws(() => parseRequest({ names: [] }), /1–6/);
  assert.throws(() => parseRequest({ names: [N('browser_tabs'), N('browser_tabs')] }), /unique/);
  assert.throws(() => parseRequest({ unknown: true }), /Unknown/);
});

test('rank maps common Chinese capability words and English API terms', () => {
  assert.equal(rank(catalog, '浏览器')[0].name, N('browser_tabs'));
  assert.equal(rank(catalog, 'dbx query')[0].name, N('dbx_execute_query'));
  assert.equal(rank(catalog, 'github file')[0].name, N('github_get_file_contents'));
});

test('lookup searches, loads exact names and resets without inventing tools', () => {
  const searched = lookup(catalog, [], { query: 'browser' });
  assert.equal(searched.action, 'search');
  assert.deepEqual(searched.selected, [N('browser_tabs')]);

  const loaded = lookup(catalog, [], { names: [N('dbx_execute_query'), N('missing')] });
  assert.deepEqual(loaded.selected, [N('dbx_execute_query')]);

  const reset = lookup(catalog, [N('browser_tabs')], { reset: true });
  assert.deepEqual(reset.selected, []);

  const status = lookup(catalog, [N('browser_tabs')], {});
  assert.equal(status.action, 'status');
  assert.equal(status.catalogSize, catalog.length);
  assert.deepEqual(status.groups, [{ name: 'fixture', count: 4 }]);
});

test('selection keeps the most recent names within the cap', () => {
  const names = Array.from({ length: MAX_LOADED + 1 }, (_, index) => N(`tool_${index}`));
  const tools = names.map(name => ({ name, description: name }));
  const first = lookup(tools, [], { names: names.slice(0, MAX_BATCH) });
  const second = lookup(tools, first.selected, { names: names.slice(MAX_BATCH, MAX_LOADED) });
  assert.deepEqual(second.selected, names.slice(0, MAX_LOADED));
  const third = lookup(tools, second.selected, { names: [names[MAX_LOADED]] });
  assert.deepEqual(third.selected, names.slice(1));
});

test('foldSelection only commits a matching, successful native result', () => {
  const call = { type: 'tool/call', seq: 5, data: { name: TOOL_NAME, callId: 'c1', turn: 1, step: 1 } };
  const pending = foldSelection(initialState(), call);
  assert.deepEqual(pending.pending, [{ callId: 'c1', seq: 5, turn: 1, step: 1 }]);

  const result = (overrides = {}) => ({
    type: 'tool/result',
    seq: 6,
    surfaceOp: 'append',
    sourceEventSeqs: [5],
    data: {
      turn: 1,
      step: 1,
      message: { toolCallId: 'c1', isError: false },
      meta: { tag: META_TAG, selected: [N('browser_tabs')] },
      ...overrides
    }
  });

  const committed = foldSelection(pending, result());
  assert.deepEqual(committed.selected, [N('browser_tabs')]);
  assert.deepEqual(committed.pending, []);

  const wrongTag = foldSelection(pending, result({ meta: { tag: 'other', selected: [N('browser_tabs')] } }));
  assert.deepEqual(wrongTag.selected, []);

  const failed = foldSelection(pending, result({ message: { toolCallId: 'c1', isError: true } }));
  assert.deepEqual(failed.selected, []);

  const replaced = foldSelection(pending, { ...result(), surfaceOp: 'replace' });
  assert.deepEqual(replaced.selected, []);
  assert.equal(replaced.pending.length, 1);

  const wrongSource = foldSelection(pending, { ...result(), sourceEventSeqs: [4] });
  assert.deepEqual(wrongSource.selected, []);
});

test('an unfinished lookup does not survive the turn', () => {
  const call = { type: 'tool/call', seq: 5, data: { name: TOOL_NAME, callId: 'c1', turn: 1, step: 1 } };
  const pending = foldSelection(initialState(), call);
  const ended = foldSelection(pending, { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } });
  assert.deepEqual(ended.pending, []);
  assert.deepEqual(ended.selected, []);
});

test('projection state validation is strict and returns a detached value', () => {
  const value = { selected: [N('browser_tabs')], pending: [{ callId: 'c1', seq: 1, turn: 1, step: 1 }] };
  const parsed = parseProjectionState(value);
  assert.deepEqual(parsed, value);
  assert.notEqual(parsed.selected, value.selected);
  assert.throws(() => parseProjectionState({ selected: ['not-magpie'], pending: [] }), /selected/);
  assert.throws(() => parseProjectionState({ selected: [], pending: [{ callId: 'c1', seq: -1, turn: 1, step: 1 }] }), /seq/);
  assert.throws(() => parseProjectionState({ selected: [], pending: [{ callId: 'c1', seq: 1, turn: 1, step: 1 }, { callId: 'c1', seq: 2, turn: 1, step: 1 }] }), /callId/);
});

test('validSelection enforces the Magpie prefix, uniqueness and cap', () => {
  assert.equal(validSelection([N('a'), N('b')]), true);
  assert.equal(validSelection(['read']), false);
  assert.equal(validSelection([N('a'), N('a')]), false);
  assert.equal(validSelection(Array.from({ length: MAX_LOADED + 1 }, (_, i) => N(`x${i}`))), false);
});
