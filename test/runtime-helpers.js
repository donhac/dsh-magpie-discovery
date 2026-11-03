import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as discovery from '../discovery.js';
import { TOOL_NAME, PREFIX, PROJECTION_KEY } from '../discovery-core.js';

// CI resolves ordinary devDependencies. A local isolated fixture can be selected
// explicitly without linking node_modules or consulting the running DSH Host.
const requireRuntime = process.env.DSH_RUNTIME_TEST_REQUIRE
  ? createRequire(pathToFileURL(process.env.DSH_RUNTIME_TEST_REQUIRE))
  : createRequire(import.meta.url);
const load = name => requireRuntime(name);
const { Context } = load('@deepseek-ai/cordis');
const { default: Loader } = load('@deepseek-ai/cordis-plugin-loader');
const { default: SystemPrompt } = load('@deepseek-ai/dsh-system-prompt');
const { default: ToolRuntime } = load('@deepseek-ai/dsh-tools');
const { default: SessionStore, SessionId } = load('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = load('@deepseek-ai/dsh-session-projection');
const { default: AgentRegistry } = load('@deepseek-ai/dsh-agent');
const { default: AgentLoop } = load('@deepseek-ai/dsh-agent-loop');
const { default: AgentPresetRegistry } = load('@deepseek-ai/dsh-agent-preset-registry');
const { default: LlmRuntime, LlmAdapter, createUserMessage } = load('@deepseek-ai/dsh-llm');

export { TOOL_NAME, PREFIX, PROJECTION_KEY };
export const N = suffix => `${PREFIX}fixture__${suffix}`;
export const OPEN = N('open_session');
export const CLOSE = N('close_session');
export const READ = N('read');
export const BLOCKED = N('blocked');
export const GUARDED = N('guarded');
let serial = 0;

export const toolCall = (name, args = {}) => ({ name, args });
export const names = request => (request.tools ?? []).map(tool => tool.name);

export async function environment({ lateHostPlugin = false } = {}) {
  const root = new Context();
  const errors = [], logs = new Map(), requests = [], calls = [], originals = new Map();
  const handles = [], presets = [];
  let script = [], responseSerial = 0, openCount = 0, closeCount = 0;
  try {
    root.on('agent/error', payload => errors.push(payload.error));
    root.on('session/event', (session, event) => {
      if (!logs.has(session.id)) logs.set(session.id, []);
      logs.get(session.id).push(event);
    });
    new Loader(root, {});
    new SystemPrompt(root, {});
    new ToolRuntime(root, { mode: 'native' });
    new SessionStore(root);
    new SessionProjectionRegistry(root);
    new AgentRegistry(root);
    new LlmRuntime(root);
    new AgentPresetRegistry(root, { default: 'standard', selectedDefault: { get: () => undefined } });
    new AgentLoop(root, { agents: [], maxParallelToolCalls: { get: () => 1 } });

    class ScriptedAdapter extends LlmAdapter {
      async *stream(request) {
        requests.push(request);
        const response = script.shift();
        if (response === undefined) throw new Error('Unexpected additional model request');
        const answer = typeof response === 'function' ? await response(request) : response;
        const id = `stub-call-${++responseSerial}`;
        const block = answer?.name
          ? { type: 'tool-call', id, name: answer.name, arguments: JSON.stringify(answer.args ?? {}) }
          : { type: 'text', text: 'fixture complete' };
        yield { type: 'block-start', index: 0, blockType: block.type };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: answer?.name ? 'tool-calls' : 'stop' } };
      }
    }
    root.llm.registerAdapter(['fixture'], new ScriptedAdapter());
    for (const name of [READ, OPEN, CLOSE, BLOCKED, GUARDED, 'generate_image', 'edit_image', 'mcp__other__read']) {
      const definition = {
        name,
        description: `In-memory fixture ${name}`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {},
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          presentationMeta: () => ({ fixture: name, original: true }),
        },
        finalizeContent: (_exec, result) => [...result.content, { type: 'text', text: 'original finalizer' }],
        execute(args, exec) {
          calls.push({ name, args, agent: exec.agent });
          if (name === OPEN) openCount++;
          if (name === CLOSE) closeCount++;
          return { name, original: true };
        },
      };
      originals.set(name, definition);
      root.tools.register(definition);
    }
    root.loader.builtins.discoveryFixture = discovery;
    presets.push(await root.agentPresets.register({ id: 'standard', plugins: [] }));
    presets.push(await root.agentPresets.register({
      id: 'donh-dev',
      plugins: lateHostPlugin ? [] : [{ name: 'cordis:discoveryFixture', config: { presetId: 'donh-dev' } }],
    }));
    const roster = await root.agentPresets.list();
    for (const preset of roster) assert.equal(preset.broken, undefined, JSON.stringify(preset));

    async function makeAgent(preset = 'donh-dev', seed) {
      const handle = await root.agents.create({
        sessionId: SessionId(`runtime-fixture-${++serial}`),
        agentOptions: { provider: 'fixture', model: 'scripted' },
        ...(seed ? { seed } : {}),
        setup: ctx => root.agentPresets.mount(ctx, preset).then(() => undefined),
      });
      handles.push(handle);
      return handle.agent;
    }
    async function run(agent, responses) {
      assert.equal(script.length, 0, 'previous script drained');
      script = [...responses];
      const start = requests.length;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'isolated fixture turn' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(errors, [], errors.map(error => error?.stack ?? String(error)).join('\n'));
      assert.equal(script.length, 0, 'every scripted adjacent request must run');
      return requests.slice(start);
    }
    async function close() {
      for (const handle of handles.toReversed()) await handle.dispose();
      for (const dispose of presets.toReversed()) await dispose();
      await root.fiber.dispose();
    }
    async function replacePresetRevision() {
      assert.equal(lateHostPlugin, false);
      // Unregister retires a definition; live Agents retain its exact revision.
      // Re-registering the id eagerly mounts a new revision for new Agents.
      await presets[1]();
      presets.push(await root.agentPresets.register({
        id: 'donh-dev',
        plugins: [{ name: 'cordis:discoveryFixture', config: { presetId: 'donh-dev' } }],
      }));
      assert.equal((await root.agentPresets.resolve('donh-dev')).broken, undefined);
    }
    async function installHostPlugin() {
      assert.equal(lateHostPlugin, true, 'late host plugin fixture must be explicitly requested');
      const fiber = root.plugin(discovery, {});
      await fiber.await();
      return fiber;
    }
    return { root, requests, calls, originals, logs, makeAgent, run, close, installHostPlugin, replacePresetRevision,
      counts: () => ({ open: openCount, close: closeCount }),
      state: agent => root.sessionProjections.stateOf(agent.session, PROJECTION_KEY),
      results: agent => logs.get(agent.id)?.filter(event => event.type === 'tool/result') ?? [],
    };
  } catch (error) {
    for (const handle of handles.toReversed()) await handle.dispose();
    for (const dispose of presets.toReversed()) await dispose();
    await root.fiber.dispose();
    throw error;
  }
}
