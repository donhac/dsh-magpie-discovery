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

// Synthetic directory metadata only: no connection settings, SQL or business logs.
const tool = (service, operation, description) => ({ name: `${PREFIX}${service}__${operation}`, description });
const directory = [
  tool('dbx', 'dbx_add_connection', 'Add a saved database connection'),
  tool('dbx', 'dbx_duplicate_connection', 'Duplicate a saved database connection'),
  tool('dbx', 'dbx_remove_connection', 'Remove a saved database connection'),
  tool('dbx', 'dbx_list_connections', 'List saved database connections'),
  tool('dbx', 'dbx_list_databases', 'List available databases'),
  tool('dbx', 'dbx_list_routines', 'List stored routines for a schema'),
  tool('dbx', 'dbx_list_tables', 'List tables available through a connection'),
  tool('dbx', 'dbx_open_session', 'Open a stateful session for a connection and query'),
  tool('dbx', 'dbx_close_session', 'Close a stateful query session'),
  tool('dbx', 'dbx_execute_query', 'Execute a SQL query in an existing session'),
  tool('dbx', 'dbx_describe_table', 'Describe table columns using a database connection'),
  tool('nyatermSsh', 'connection_list', 'List saved terminal connections'),
  tool('nyatermSsh', 'session_open', 'Open a remote terminal session'),
  tool('nyatermSsh', 'terminal_execute', 'Execute a command in a terminal session'),
  tool('nyatermSsh', 'sftp_read_text', 'Read text from a remote file'),
  tool('github', 'create_repository', 'Create a repository for DBX connection and session query examples'),
  tool('github', 'get_file_contents', 'Read a repository file')
];
const names = tools => tools.map(tool => tool.name);
const D = operation => `${PREFIX}dbx__dbx_${operation}`;
const S = operation => `${PREFIX}nyatermSsh__${operation}`;

test('scoped queries can list several capabilities without requiring every word on one tool', () => {
  const result = lookup(directory, [], { query: 'dbx list connections sessions read only query', limit: MAX_BATCH });
  assert.ok(result.totalMatches > 0);
  for (const operation of ['list_connections', 'open_session', 'execute_query']) {
    assert.ok(names(result.matches).includes(D(operation)), operation);
  }
  assert.ok(result.matches.every(tool => tool.name.startsWith(`${PREFIX}dbx__`)));
  assert.equal(result.matches.length, MAX_BATCH);
  assert.equal(result.hasMore, true);

  const ssh = lookup(directory, [], { query: 'nyatermSsh connection_list session_open terminal_execute', limit: MAX_BATCH });
  assert.deepEqual(names(ssh.matches), ['connection_list', 'session_open', 'terminal_execute'].map(S));
  assert.deepEqual(ssh.selected, names(ssh.matches));
  assert.equal(ssh.totalMatches, 3);
});

test('connection discovery prefers reading tools and treats plus as a separator', () => {
  const plain = rank(directory, 'dbx connection');
  assert.deepEqual(rank(directory, '+dbx connection'), plain);
  assert.equal(plain[0].name, D('list_connections'));
  for (const operation of ['add_connection', 'duplicate_connection', 'remove_connection']) {
    assert.ok(plain.findIndex(tool => tool.name === D('list_connections')) < plain.findIndex(tool => tool.name === D(operation)));
  }
  assert.deepEqual(names(rank(directory, 'dbx read-only connections')), names(plain));
  assert.ok(plain.some(tool => tool.name === D('duplicate_connection')));
  assert.ok(plain.some(tool => tool.name === D('remove_connection')));
});

test('explicit write intent still ranks the requested operations first', () => {
  for (const [intent, operation] of [
    ['add', 'add_connection'], ['create', 'add_connection'],
    ['duplicate', 'duplicate_connection'], ['remove', 'remove_connection'], ['delete', 'remove_connection']
  ]) {
    const result = lookup(directory, [], { query: `dbx ${intent} connection` });
    assert.equal(result.matches[0].name, D(operation), intent);
    assert.ok(result.selected.includes(D(operation)), intent);
  }
  assert.equal(rank(directory, 'github create repository')[0].name, `${PREFIX}github__create_repository`);
});

test('service names are hard scopes and unknown keywords do not cause broad loads', () => {
  for (const query of ['dbx connection', '数据库 query', 'DBX', 'nyatermSsh session']) {
    const expected = /nyaterm/i.test(query) ? 'nyatermSsh' : 'dbx';
    const result = rank(directory, query);
    assert.ok(result.length, query);
    assert.ok(result.every(tool => tool.name.startsWith(`${PREFIX}${expected}__`)), query);
  }
  for (const query of ['dbx nonexistent', 'dbx connection nonexistent', 'dbx list connections nonexistent', 'dbx repository', 'missingservice connection', '+++']) {
    const result = lookup(directory, [D('list_connections')], { query });
    assert.deepEqual(result.matches, [], query);
    assert.deepEqual(result.selected, [D('list_connections')], query);
    assert.equal(result.totalMatches, 0, query);
    assert.equal(result.hasMore, false, query);
  }
  // Unscoped prose retains conjunctive matching instead of spreading over services.
  assert.deepEqual(rank(directory, 'remote repository'), []);
});

test('exact full names rank first and explicit loads preserve order and unavailable-name behavior', () => {
  // The longer name also matches the whole query and earns a reading preference.
  const overlap = [...directory, tool('dbx', 'dbx_add_connection_list', 'List connection setup helpers')];
  for (const exact of [D('add_connection'), D('list_connections'), S('terminal_execute')]) {
    assert.equal(rank(overlap, exact)[0].name, exact);
  }
  assert.equal(rank(overlap, `+${D('add_connection')}`)[0].name, D('add_connection'));
  const requested = [D('remove_connection'), S('session_open'), D('list_connections')];
  assert.deepEqual(names(rank(directory, 'connection_list session_open terminal_execute')), ['connection_list', 'session_open', 'terminal_execute'].map(S));
  const loaded = lookup(directory, [], { names: [...requested, D('unavailable')] });
  assert.deepEqual(names(loaded.matches), requested);
  assert.deepEqual(loaded.selected, requested);
  assert.equal(loaded.totalMatches, requested.length);
});

test('multi-operation search pagination stays bounded and selection retains its existing cap', () => {
  const query = 'dbx list connections sessions read only query';
  const ordered = rank(directory, query);
  const first = lookup(directory, [], { query, limit: MAX_BATCH });
  const second = lookup(directory, first.selected, { query, limit: MAX_BATCH, offset: MAX_BATCH });
  assert.deepEqual([...names(first.matches), ...names(second.matches)], names(ordered));
  assert.equal(first.totalMatches, ordered.length);
  assert.equal(second.totalMatches, ordered.length);
  assert.equal(second.hasMore, false);
  assert.ok(second.matches.length <= MAX_BATCH);
  const beyond = lookup(directory, second.selected, { query, limit: MAX_BATCH, offset: 100 });
  assert.deepEqual(beyond.matches, []);
  assert.deepEqual(beyond.selected, second.selected);
  assert.equal(beyond.hasMore, false);
  assert.throws(() => lookup(directory, [], { query, limit: MAX_BATCH + 1 }), /limit/);

  const initial = Array.from({ length: MAX_LOADED }, (_, index) => N(`previous_${index}`));
  const bounded = lookup(directory, initial, { query, limit: MAX_BATCH });
  assert.equal(bounded.selected.length, MAX_LOADED);
  assert.deepEqual(bounded.selected, [...initial.slice(MAX_BATCH), ...names(first.matches)]);
  assert.equal(validSelection(bounded.selected), true);
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
