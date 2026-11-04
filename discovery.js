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
export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'agentPresets', 'agents'];

const namesSchema = { type: 'array', items: { type: 'string' } };
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'matches', 'selected', 'added', 'evicted', 'unchanged', 'totalMatches', 'hasMore', 'catalogSize', 'groups'],
  properties: {
    action: { type: 'string', enum: ['status', 'search', 'load', 'replace', 'reset'] },
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
    added: namesSchema,
    evicted: namesSchema,
    unchanged: namesSchema,
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
  const owns = agent => {
    if (ownerPreset !== undefined && compositionOf(agent.ctx) !== ownerPreset) return false;
    // Live preset revisions may share an id. Only manage the revision that
    // resolves this discovery definition; an external deny is not an exit.
    const visible = ctx.tools.get(TOOL_NAME, agent);
    return visible === undefined || visible === toolDefinition;
  };
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
            const next = deny.length ? agent.ctx.tools.restrict({ deny }) : null;
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
      let removeExitCheck, removeCommitCheck;
      const cleanup = () => {
        if (state.closing) return;
        state.closing = true;
        agents.delete(agent);
        removeExitCheck?.();
        removeCommitCheck?.();
        state.mask?.();
        state.mask = null;
      };
      try {
        refresh();
        // The loop assembles schemas BEFORE pre-step. Observe committed events
        // synchronously so the next assembly sees the new selection. stateOf()
        // materializes the pure projection; listener ordering cannot stale it.
        removeCommitCheck = agent.ctx.on('session/event', (session, event) => {
          if (session !== agent.session || !['tool/result', 'agent-preset/selected'].includes(event.type)) return;
          syncSession(session);
        });
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

  function syncSession(session) {
    if (closing) return;
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session !== session) return;
    try {
      if (!owns(agent)) { agents.get(agent)?.dispose?.(); return; }
      attach(agent);
      refresh();
    } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
  }

  function reconcile() {
    if (closing) return;
    // Handles existing blank agents selecting a preset, and mounting/reloading
    // this plugin while an agent already exists. No synthetic agent is created.
    for (const agent of ctx.agents.list()) {
      try { attach(agent); } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
    }
    refresh();
  }

  const toolDefinition = {
    name: TOOL_NAME,
    description: 'Find Magpie MCP tools and select their original definitions for the next model step. An empty call returns service counts; original permissions still apply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Service and task keywords, Chinese or English; 1–160 characters. Multiple operation names are alternatives. Separate from names/reset.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Load 1–6 unique exact mcp__magpie__ tool names; with replace:true, supply the full set of 1–12.' },
        replace: { type: 'boolean', description: 'Only with names, separate from query/reset/limit/offset. True atomically replaces selection; any unavailable name fails unchanged. Default false adds names.' },
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
    text: `Magpie provides browser/web, GitHub, DBX databases, SSH and TapTap capabilities. Call already visible tools directly; use magpie_tools for missing tools, then their original names on the next step. Selection is not authorization. At most ${MAX_LOADED} tools remain loaded. When changing phases, names with replace:true sets the full selection; include needed cleanup tools. Rediscover evicted tools when needed. Other DSH tools, including installed image generation/editing plugins, remain directly available. Never call an unrelated tool or use placeholder arguments just to advance discovery.`
  };

  // Exact yielded disposers are adopted into this ordered effect. Teardown is
  // reverse order: close/release agents, remove listeners/tools, projection last.
  ctx.effect(function* () {
    yield ctx.sessionProjections.register(projection);
    yield ctx.tools.register(toolDefinition);
    yield ctx.systemPrompt.section(section);
    yield ctx.on('tools/change', reconcile);
    yield ctx.on('session/event', (session, event) => {
      // A blank agent's preset switch does not emit agent/created. The selected
      // event is committed after rebinding, before its first model assembly.
      if (event.type === 'agent-preset/selected') syncSession(session);
    });
    yield ctx.on('agent/created', ({ agent }) => {
      try { attach(agent); } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
    });
    // Defensive fallback only; normal updates happen before schema assembly.
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
    reconcile();
  }, 'magpie-tool-discovery ordered lifecycle');

  return { attach, refresh, projection, trackedAgents: () => agents.size };
}
