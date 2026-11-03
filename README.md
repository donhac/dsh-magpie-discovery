# dsh-magpie-discovery

On-demand Magpie MCP tool discovery for DeepSeek Harness agents.

Magpie exposes browser, web search, GitHub, DBX databases, SSH and TapTap capabilities through one MCP Hub. DSH's native MCP client registers every tool schema up front, which can put 150+ definitions in every request. This plugin adds one small lookup tool (`magpie_tools`) and reveals the original Magpie tool only after it has been selected.

It is a visibility layer, not a second MCP client and not a call proxy. Selected tools execute through DSH's original tool pipeline, so images, structured values, errors, approvals and result metadata keep their native behavior.

**This is a plugin, not an agent preset.** It can be mounted in any preset that needs Magpie tools, or enabled once for every agent. It does not define a coding mode, persona, model route or image workflow.

## What it provides

- `magpie_tools`: search, load by exact name, show status, or reset the current selection.
- Per-session selection restored from the native session log on resume, compaction and fork.
- A deny-mask visibility layer that leaves the original Magpie definitions and execution path intact.
- No new MCP connection, account store, OAuth configuration or remote call wrapper.

## Requirements

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0` (tested with `0.2.1-rc.5`).
- Node.js `>=22.19.0`.
- Magpie running with its MCP Hub, and the existing DSH MCP client already connected to Magpie.
- A composition that mounts this package: a preset child, or the opt-in Host row installed by the bundle.

This plugin does **not** create a Magpie connection. If no Magpie MCP server is configured, `magpie_tools` reports an empty catalog and other tools continue to work.

## Install

From Plugin Manager, choose **Install bundle** and enter:

```text
github:donhac/dsh-magpie-discovery
```

Or from the DSH CLI:

```sh
dsh plugin --profile <profile> add github:donhac/dsh-magpie-discovery
```

For a pinned release:

```text
github:donhac/dsh-magpie-discovery#v1.0.0
```

The installed bundle and plugin row are displayed as **dsh-magpie-discovery**. The bundle also inserts a **disabled** Host row named `magpie-tool-discovery`. Choose one of the two usage modes below.

## Use

### Option A: mount in a preset (recommended)

Add the package to the `plugins` list of an `@deepseek-ai/dsh-agent-preset` row:

```yaml
- id: magpie-tool-discovery
  name: dsh-magpie-discovery
  config:
    presetId: my-preset
```

- `presetId` must be the id of the preset that contains this row.
- It lets the plugin remove its restriction when an agent switches away from the preset.
- The plugin needs the Host services `tools`, `systemPrompt`, `sessionProjections` and `agentPresets`.

This mode scopes discovery to agents using that preset. Other presets keep their full Magpie tool set.

### Option B: enable the Host row (global)

In Plugin Manager, enable the installed `magpie-tool-discovery` row. The plugin then applies to every agent in the profile.

Do **not** enable the Host row and also mount the package in a preset. That creates two instances registering the same `magpie_tools` name and projection key.

### Look up tools

```js
magpie_tools({ query: 'browser tabs', limit: 2 })
magpie_tools({ query: '数据库表结构' })
magpie_tools({ names: ['mcp__magpie__playwright__browser_tabs'] })
magpie_tools({})
magpie_tools({ reset: true })
```

- `query` searches names and descriptions. English API terms and common Chinese capability words both work.
- `names` loads 1–6 exact `mcp__magpie__...` names.
- `limit` is 1–6 and defaults to 3; `offset` pages through matches.
- An empty call returns the current selection and service counts.
- `reset` clears the current selection.

The selected tool becomes visible on the **next model step**. This is intentional: a tool call planned in the same assistant step cannot use a definition that was not in that request. Look first, then call the original tool on the following step.

At most 12 recently selected tools stay loaded. Selecting a tool again refreshes its position; an older selection is evicted when the cap is exceeded.

## How it works

The plugin inspects global tool names beginning with `mcp__magpie__`. For each agent it installs one restriction:

```text
deny = current Magpie catalog - tools selected in this session
```

The restriction affects schema presentation, lookup and dispatch together. It never copies, wraps or re-registers a real Magpie tool, so the tool that runs is still the original definition.

The selection itself is derived from the native session log. `magpie_tools` writes a versioned marker and the complete post-selection list into the tool result's `presentationMeta`. A host-only session projection accepts that state only when:

- the result belongs to a real `magpie_tools` call;
- the source event and turn/step match;
- the result is a successful append (not a failure, cancellation, pruner replacement or fork-closer);
- the metadata version and selected names validate.

A returned value that has not been committed as a tool result does not unlock anything.

Selection, restrictions and listeners are installed in an ordered lifecycle. On unload, agent policies are released first, then listeners and the tool, with the projection last. On a preset switch, the old mask is removed and the new preset re-attaches on its first pre-step.

## Configuration

| Field | Required | Meaning |
|---|---|---|
| `presetId` | Recommended for preset mounts | The preset id that owns this instance. Used to detach when an agent switches presets. |

The Host row needs no configuration and behaves globally. A preset mount without `presetId` falls back to the current preset identity at activation; setting it explicitly is safer and is required if you want deterministic cleanup across composition reloads.

## Safety and limits

- **Selection is not authorization.** Other plugins' allow/deny rules, guards and approvals still apply. A search hit only proposes a tool; the final callable set is the intersection with every other policy.
- **Not a sandbox.** This controls model-visible tool definitions. It does not disconnect MCP, remove server instructions, or restrict filesystem/network permissions.
- **Magpie-only.** Only global names starting with `mcp__magpie__` are hidden. Other MCP servers, native tools and image plugins are untouched.
- **Same-name scoped tools.** If another plugin registers a real tool with the same name directly in an agent's own scope, DSH's scoped-own exemption means this restriction cannot hide it. That topology is unsupported.
- **Native presentation.** The projection recognizes native `tool/call` and `tool/result` events from `magpie_tools`. A preset that switches to PTC records calls differently and will not update the selection.
- **Public names, not remote identity.** Reconnection restores a selection by tool name. It does not prove that a reconnected server exposes the same remote implementation.
- **No reduction in MCP server instructions.** Deferring tool schemas does not remove instructions the Magpie server itself provides.
- **Disconnected servers.** If Magpie disconnects, its tools disappear immediately; the selected names remain and restore when the same names are registered again.
- **One-step visibility.** A tool selected in a step is available from the next model request, not retroactively in the current request.

## Compatibility

The plugin is designed for presets that use DSH's `native` tool presentation. It does not require or provide PTC.

Image generation and editing are intentionally out of scope. Any image plugin installed in the profile continues to register its own tools; this plugin does not import, proxy or modify them.

## Development

The package has no runtime dependencies and no build step.

```sh
npm test
```

The tests cover request validation, Chinese/English ranking, the 12-tool cap, exact loading, reset, projection state validation and the rule that only a committed, matching, successful native result grants a selection.

To try a local checkout:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-magpie-discovery
```

After changing code, use Plugin Manager to remove and reinstall the bundle; a linked local package loads a fresh module generation only after reinstallation.

## Uninstall

Remove the bundle in Plugin Manager, or:

```sh
dsh plugin --profile <profile> remove dsh-magpie-discovery
```

If you mounted the package in a preset, remove that preset row first. New sessions no longer see the discovery tool; existing sessions keep their revision until they end.

## License

MIT. See [LICENSE](./LICENSE).
