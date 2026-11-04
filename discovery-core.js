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
  if (Object.keys(args).some(key => !['query', 'names', 'replace', 'limit', 'offset', 'reset'].includes(key))) throw new Error('Unknown lookup parameter.');
  const hasQuery = args.query !== undefined;
  const hasNames = args.names !== undefined;
  const hasReplace = args.replace !== undefined;
  const reset = args.reset === true;
  if (args.reset !== undefined && typeof args.reset !== 'boolean') throw new Error('reset must be a boolean.');
  if (hasReplace && typeof args.replace !== 'boolean') throw new Error('replace must be a boolean.');
  if (hasReplace && (!hasNames || hasQuery || args.reset !== undefined || args.limit !== undefined || args.offset !== undefined)) throw new Error('replace applies to names only; separate from query, reset, limit and offset.');
  if (Number(hasQuery) + Number(hasNames) + Number(reset) > 1) throw new Error('Use query, names, or reset separately.');
  if (hasQuery && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 160)) throw new Error('query must contain 1–160 characters.');
  const maxNames = args.replace === true ? MAX_LOADED : MAX_BATCH;
  if (hasNames && (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > maxNames || !args.names.every(isName) || new Set(args.names).size !== args.names.length)) throw new Error(`names must contain 1–${maxNames} unique exact Magpie tool names.`);
  for (const [key, fallback, max] of [['limit', 3, MAX_BATCH], ['offset', 0, 10000]]) {
    const value = args[key] ?? fallback;
    if (!Number.isInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new Error(`Invalid ${key}.`);
  }
  if (!hasQuery && (args.limit !== undefined || args.offset !== undefined)) throw new Error('limit and offset apply to query only.');
  return { action: hasQuery ? 'search' : hasNames ? args.replace === true ? 'replace' : 'load' : reset ? 'reset' : 'status', query: args.query?.trim(), names: args.names, limit: args.limit ?? 3, offset: args.offset ?? 0 };
}

const readActions = new Set(['list', 'get', 'read', 'describe', 'search', 'find', 'check', 'inspect']);
const actionAliases = [['create', 'add'], ['remove', 'delete']];

export function rank(catalog, query) {
  const normalized = query.toLowerCase().replace(/\+/g, ' ').trim();
  const groups = [];
  // "read only" is a ranking hint, not a capability shared by every requested tool.
  const terms = normalized.replace(/\bread[\s_-]+only\b/g, ' ');
  for (const term of terms.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(term)) {
      const mapped = aliases.filter(([word]) => term.includes(word)).map(([, synonyms]) => synonyms);
      groups.push(...(mapped.length ? mapped : [[term]]));
    } else groups.push(actionAliases.find(words => words.includes(term)) ?? [term]);
  }
  if (!groups.length) return [];
  const entries = catalog.map(tool => {
    const name = tool.name.toLowerCase();
    const [service, operation] = name.slice(PREFIX.length).split('__');
    return { tool, name, service, operation, description: tool.description.toLowerCase() };
  });
  const services = new Set(entries.map(entry => entry.service));
  const scope = new Set(groups.flatMap(group => group.filter(term => services.has(term))));
  const keywords = groups.filter(group => !group.some(term => scope.has(term)));
  const scoped = entries.filter(entry => !scope.size || scope.has(entry.service));
  const operations = new Set(scoped.flatMap(entry => [entry.name, entry.operation]));
  const alternatives = scope.size > 0 || keywords.length > 1 && keywords.every(group => group.some(term => operations.has(term)));
  const matches = scoped.map(entry => {
    const scores = keywords.map(group => {
      // In a capability list, generic reading verbs carry less weight than subjects.
      const nameScore = keywords.length > 1 && group.some(word => readActions.has(word)) ? 10 : 30;
      return Math.max(...group.map(term => {
        // Small plural folding handles connections/sessions without a language parser.
        const forms = term.endsWith('s') && term.length > 4 ? [term, term.slice(0, -1)] : [term];
        return Math.max(...forms.map(word => entry.name.includes(word) ? nameScore : entry.description.includes(word) ? 5 : 0));
      }));
    });
    return { ...entry, scores };
  });
  // Relax per-tool AND only after every keyword is accounted for inside the service.
  // Unknown words must not turn a search into a broad automatic load.
  if (keywords.some((_, index) => !matches.some(entry => entry.scores[index]))) return [];
  return matches.filter(entry => !keywords.length || (alternatives ? entry.scores.some(Boolean) : entry.scores.every(Boolean))).map(entry => {
    const readBonus = entry.operation?.split('_').some(word => readActions.has(word)) ? 10 : 0;
    const score = (entry.name === normalized ? 10000 : 0) + entry.scores.reduce((sum, value) => sum + value, 0) + readBonus;
    return { tool: entry.tool, score };
  }).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map(match => match.tool);
}

export function lookup(catalog, selected, args) {
  const request = parseRequest(args);
  let candidates = [];
  let totalMatches = 0;
  if (request.action === 'search') {
    const matches = rank(catalog, request.query);
    totalMatches = matches.length;
    candidates = matches.slice(request.offset, request.offset + request.limit);
  } else if (request.action === 'load' || request.action === 'replace') {
    const byName = new Map(catalog.map(tool => [tool.name, tool]));
    if (request.action === 'replace') {
      const unavailable = request.names.filter(name => !byName.has(name));
      if (unavailable.length) throw new Error(`Unavailable Magpie tool names: ${unavailable.join(', ')}. Selection unchanged.`);
    }
    candidates = request.names.map(name => byName.get(name)).filter(Boolean);
    totalMatches = candidates.length;
  }
  const candidateNames = candidates.map(tool => tool.name);
  const next = request.action === 'reset' ? [] : request.action === 'replace' ? candidateNames : select(selected, candidateNames);
  const before = new Set(selected);
  const after = new Set(next);
  const groups = new Map();
  for (const tool of catalog) {
    const service = tool.name.slice(PREFIX.length).split('__')[0];
    groups.set(service, (groups.get(service) ?? 0) + 1);
  }
  return {
    action: request.action,
    matches: candidates.map(tool => ({ name: tool.name, description: tool.description.slice(0, 360) })),
    selected: next,
    added: next.filter(name => !before.has(name)),
    evicted: selected.filter(name => !after.has(name)),
    unchanged: next.filter(name => before.has(name)),
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
