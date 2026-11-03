// Pure, log-derived selection policy. This module never executes an MCP tool.
export const TOOL_NAME = 'magpie_tools';
export const PREFIX = 'mcp__magpie__';
export const PROJECTION_KEY = 'magpieToolDiscovery';
export const META_TAG = 'dsh-magpie-discovery/discovery/v1';
export const MAX_LOADED = 12;
export const MAX_BATCH = 6;

const aliases = [
  ['浏览器', ['playwright', 'browser']], ['截图', ['screenshot']],
  ['网页', ['playwright', 'web']], ['搜索', ['search', 'find']],
  ['数据库', ['dbx']], ['表结构', ['schema', 'describe_table']],
  ['终端', ['nyatermssh']], ['服务器', ['nyatermssh']],
  ['仓库', ['github']], ['代码审查', ['review']], ['提交', ['commit']],
  ['议题', ['issue']], ['拉取请求', ['pull_request']],
  ['小游戏', ['taptap']], ['排行榜', ['leaderboard']],
  ['广告', ['ads', 'ad_integration']], ['云存档', ['cloud_save']],
  ['分享', ['share']], ['联机', ['multiplayer']]
];

const isName = name => typeof name === 'string' && name.startsWith(PREFIX) && name.length <= 192;

export function validSelection(names) {
  return Array.isArray(names) && names.length <= MAX_LOADED && names.every(isName) && new Set(names).size === names.length;
}

export function select(current, additions) {
  const touched = new Set(additions);
  return [...current.filter(name => !touched.has(name)), ...additions].slice(-MAX_LOADED);
}

export function parseRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  if (Object.keys(args).some(key => !['query', 'names', 'limit', 'offset', 'reset'].includes(key))) throw new Error('Unknown lookup parameter.');
  const hasQuery = args.query !== undefined;
  const hasNames = args.names !== undefined;
  const reset = args.reset === true;
  if (args.reset !== undefined && typeof args.reset !== 'boolean') throw new Error('reset must be a boolean.');
  if (Number(hasQuery) + Number(hasNames) + Number(reset) > 1) throw new Error('Use query, names, or reset separately.');
  if (hasQuery && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 160)) throw new Error('query must contain 1–160 characters.');
  if (hasNames && (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > MAX_BATCH || !args.names.every(isName) || new Set(args.names).size !== args.names.length)) throw new Error(`names must contain 1–${MAX_BATCH} unique exact Magpie tool names.`);
  for (const [key, fallback, max] of [['limit', 3, MAX_BATCH], ['offset', 0, 10000]]) {
    const value = args[key] ?? fallback;
    if (!Number.isInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new Error(`Invalid ${key}.`);
  }
  if (!hasQuery && (args.limit !== undefined || args.offset !== undefined)) throw new Error('limit and offset apply to query only.');
  return { action: hasQuery ? 'search' : hasNames ? 'load' : reset ? 'reset' : 'status', query: args.query?.trim(), names: args.names, limit: args.limit ?? 3, offset: args.offset ?? 0 };
}

export function rank(catalog, query) {
  const normalized = query.toLowerCase();
  const groups = [];
  for (const term of normalized.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(term)) {
      const mapped = aliases.filter(([word]) => term.includes(word)).map(([, synonyms]) => synonyms);
      groups.push(...(mapped.length ? mapped : [[term]]));
    } else groups.push([term]);
  }
  if (!groups.length) return [];
  return catalog.map(tool => {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = name === normalized ? 10000 : 0;
    for (const group of groups) {
      const best = Math.max(...group.map(term => name.includes(term) ? 30 : description.includes(term) ? 5 : 0));
      if (!best) return null;
      score += best;
    }
    return { tool, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map(match => match.tool);
}

export function lookup(catalog, selected, args) {
  const request = parseRequest(args);
  let candidates = [];
  let totalMatches = 0;
  if (request.action === 'search') {
    const matches = rank(catalog, request.query);
    totalMatches = matches.length;
    candidates = matches.slice(request.offset, request.offset + request.limit);
  } else if (request.action === 'load') {
    const byName = new Map(catalog.map(tool => [tool.name, tool]));
    candidates = request.names.map(name => byName.get(name)).filter(Boolean);
    totalMatches = candidates.length;
  }
  const next = request.action === 'reset' ? [] : select(selected, candidates.map(tool => tool.name));
  const groups = new Map();
  for (const tool of catalog) {
    const service = tool.name.slice(PREFIX.length).split('__')[0];
    groups.set(service, (groups.get(service) ?? 0) + 1);
  }
  return {
    action: request.action,
    matches: candidates.map(tool => ({ name: tool.name, description: tool.description.slice(0, 360) })),
    selected: next,
    totalMatches,
    hasMore: request.action === 'search' && request.offset + candidates.length < totalMatches,
    catalogSize: catalog.length,
    groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }))
  };
}

export function initialState() { return { selected: [], pending: [] }; }

export function parseProjectionState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Magpie discovery state must be an object.');
  const { selected, pending } = value;
  if (!validSelection(selected)) throw new Error('Magpie discovery state has an invalid selected list.');
  if (!Array.isArray(pending) || pending.length > 64) throw new Error('Magpie discovery state has an invalid pending list.');
  const seen = new Set();
  const nextPending = pending.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Magpie discovery state has an invalid pending entry.');
    const { callId, seq, turn, step } = item;
    if (typeof callId !== 'string' || callId.length < 1 || callId.length > 256 || seen.has(callId)) throw new Error('Magpie discovery state has an invalid pending callId.');
    seen.add(callId);
    for (const [name, number] of [['seq', seq], ['turn', turn], ['step', step]]) {
      if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Magpie discovery state has an invalid pending ${name}.`);
    }
    return { callId, seq, turn, step };
  });
  return { selected: [...selected], pending: nextPending };
}

export function foldSelection(state, event) {
  if (event.type === 'tool/call' && event.data.name === TOOL_NAME) {
    const call = event.data;
    return { ...state, pending: [...state.pending.filter(item => item.callId !== call.callId), { callId: call.callId, seq: event.seq, turn: call.turn, step: call.step }].slice(-64) };
  }
  if (event.type === 'tool/result' && event.surfaceOp === 'append') {
    const { message, meta } = event.data;
    const pending = state.pending.find(item => item.callId === message.toolCallId);
    if (!pending) return state;
    const remaining = state.pending.filter(item => item !== pending);
    const valid = message.isError !== true && !event.data.error && meta?.tag === META_TAG && validSelection(meta.selected)
      && event.sourceEventSeqs?.length === 1 && event.sourceEventSeqs[0] === pending.seq
      && event.data.turn === pending.turn && event.data.step === pending.step;
    return { selected: valid ? [...meta.selected] : state.selected, pending: remaining };
  }
  if ((event.type === 'turn/end' || event.type === 'step/end') && state.pending.length) return { ...state, pending: [] };
  return state;
}
