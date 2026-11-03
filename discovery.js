import {
  TOOL_NAME,
  PREFIX,
  PROJECTION_KEY,
  META_TAG,
  MAX_LOADED,
  foldSelection,
  initialState,
  lookup,
  parseProjectionState
} from './discovery-core.js';

export const name = 'dsh-magpie-discovery';
export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'agentPresets'];

const namesSchema = { type: 'array', items: { type: 'string' } };
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'matches', 'selected', 'totalMatches', 'hasMore', 'catalogSize', 'groups'],
  properties: {
    action: { type: 'string', enum: ['status', 'search', 'load', 'reset'] },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: { name: { type: 'string' }, description: { type: 'string' } }
      }
    },
    selected: namesSchema,
    totalMatches: { type: 'integer' },
    hasMore: { type: 'boolean' },
    catalogSize: { type: 'integer' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'count'],
        properties: { name: { type: 'string' }, count: { type: 'integer' } }
      }
    }
  }
};

/**
 * Mount the discovery policy. `config.presetId` identifies the preset this
 * plugin belongs to; the included bundle sets it. A preset that mounts this
 * package itself should set it as well so preset switches clean up correctly.
 */
export function apply(ctx, config = {}) {
  createDiscovery(ctx, config);
}

export function createDiscovery(ctx, config = {}) {
  const agents = new Map();
  let closing = false;
  let refreshing = false;
  let dirty = false;
  let catalog = [];

  const compositionOf = subject => {
    try { return ctx.agentPresets.composedPreset(subject); } catch { return undefined; }
  };
  const ownerPreset = config.presetId ?? compositionOf(ctx);
  const owns = agent => ownerPreset === undefined || compositionOf(agent.ctx) === ownerPreset;
  const readCatalog = () => ctx.tools.schemas().filter(tool => tool.name.startsWith(PREFIX));
  const warn = message => {
    try { ctx.logger?.warn?.(`magpie-tool-discovery: ${message}`); } catch { /* logging must not break the step */ }
  };

  const projection = {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: { parse: parseProjectionState },
    init: initialState,
    apply: foldSelection
  };

  const stateOf = agent => {
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    if (!state) throw new Error('Magpie discovery projection is unavailable.');
    return state;
  };

  function refresh() {
    if (closing) return;
    if (refreshing) { dirty = true; return; }
    refreshing = true;
    try {
      // Our own restriction notifications require at most one settling pass.
      let passes = 0;
      do {
        dirty = false;
        if (++passes > 32) throw new Error('Magpie tool registry did not settle.');
        catalog = readCatalog();
        for (const [agent, state] of agents) {
          if (state.closing) continue;
          if (!owns(agent)) { state.dispose?.(); continue; }
          try {
            const selected = new Set(stateOf(agent).selected);
            const deny = catalog.map(tool => tool.name).filter(name => !selected.has(name)).sort();
            const signature = JSON.stringify(deny);
            if (signature === state.signature) continue;
            // Install first: the overlap is more restrictive, never an all-tools gap.
            const next = agent.ctx.tools.restrict({ deny });
            const previous = state.mask;
            state.mask = next;
            state.signature = signature;
            previous?.();
          } catch (error) {
            warn(error instanceof Error ? error.message : String(error));
          }
        }
      } while (dirty && !closing);
    } finally {
      refreshing = false;
    }
  }

  function attach(agent) {
    if (closing || agents.has(agent) || !owns(agent)) return;
    const state = { signature: null, mask: null, closing: false, dispose: null };
    const dispose = agent.ctx.effect(() => {
      agents.set(agent, state);
      let removeExitCheck;
      const cleanup = () => {
        if (state.closing) return;
        state.closing = true;
        agents.delete(agent);
        removeExitCheck?.();
        state.mask?.();
        state.mask = null;
      };
      try {
        refresh();
        removeExitCheck = agent.ctx.on('agent/pre-step', async (_payload, next) => {
          if (!owns(agent)) state.dispose?.();
          return next();
        });
      } catch (error) {
        cleanup();
        throw error;
      }
      return cleanup;
    }, 'magpie-tool-discovery agent policy');
    state.dispose = dispose;
  }

  const toolDefinition = {
    name: TOOL_NAME,
    description: 'Find Magpie MCP tools and select their original definitions for the next model step. An empty call returns service counts; original permissions still apply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Task keywords, Chinese or English; 1–160 characters. Separate from names/reset.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Load 1–6 exact mcp__magpie__ tool names instead of searching.' },
        limit: { type: 'integer', description: 'Search page size, 1–6; default 3.' },
        offset: { type: 'integer', description: 'Search page offset; default 0.' },
        reset: { type: 'boolean', description: 'True clears selected MCP tools; separate from query/names.' }
      }
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({ tag: META_TAG, selected: value.selected })
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Magpie discovery requires an owning agent session.');
      if (!agents.has(exec.agent)) {
        if (!owns(exec.agent)) throw new Error('Magpie discovery is not available in this preset.');
        attach(exec.agent);
      }
      if (exec.signal.aborted) throw exec.signal.reason ?? new Error('Lookup cancelled.');
      // This result becomes selection state only when its native tool/result commits.
      return lookup(readCatalog(), stateOf(exec.agent).selected, args);
    }
  };

  const section = {
    name: 'magpie-tool-discovery',
    order: 3900,
    text: `Magpie provides browser/web, GitHub, DBX databases, SSH and TapTap capabilities. Use magpie_tools to discover relevant MCP tools, then call their original names on the following model step. Selection is not authorization. At most ${MAX_LOADED} recently selected tools remain loaded; rediscover an evicted tool when needed. Other DSH tools, including installed image generation/editing plugins, remain directly available.`
  };

  // Exact yielded disposers are adopted into this ordered effect. Teardown is
  // reverse order: close/release agents, remove listeners/tools, projection last.
  ctx.effect(function* () {
    yield ctx.sessionProjections.register(projection);
    yield ctx.tools.register(toolDefinition);
    yield ctx.systemPrompt.section(section);
    yield ctx.on('tools/change', refresh);
    yield ctx.on('agent/created', ({ agent }) => {
      try { attach(agent); } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
    });
    // Covers a blank existing agent selecting this preset before its first request.
    yield ctx.on('agent/pre-step', async ({ agent }, next) => {
      try { attach(agent); refresh(); } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
      return next();
    });
    yield ctx.on('agent/disposed', ({ agent }) => {
      try { agents.get(agent)?.dispose?.(); } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
    });
    yield () => {
      closing = true;
      for (const state of [...agents.values()]) state.dispose?.();
      agents.clear();
    };
  }, 'magpie-tool-discovery ordered lifecycle');

  return { attach, refresh, projection, trackedAgents: () => agents.size };
}
