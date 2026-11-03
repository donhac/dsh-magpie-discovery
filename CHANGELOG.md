# Changelog

## 1.1.0 — 2026-11-03

- Refresh the session projection and visibility mask synchronously after committed native tool results, before the next schema assembly. A successful discovery result is available in the immediately following model request.
- Attach blank agents when preset selection commits, and reconcile agents that already exist when the plugin mounts. Keep `agent/pre-step` as a defensive fallback. Require the Host `agents` service alongside the existing services.
- Support service-scoped searches with multiple capability or operation terms. Every term must match within the service; unknown terms return no matches. Prefer connection-list discovery for generic connection queries, retain explicit write searches and exact-name priority, and treat `+` as a separator. Ranking does not grant read-only authorization.
- Preserve exact-name loading, pagination, the 6-tool lookup and 12-tool selection limits, committed-result validation and DSH's native execution, approvals, output metadata and finalizers.
- Add regressions using the real DSH AgentLoop and a scripted adapter. Coverage includes first and adjacent requests, preset selection and retained revisions, replay, unload, independent agents, external deny/guard rules and native image definitions. Fixtures remain in memory and make no network, business MCP or image-provider calls.

Run `npm ci --ignore-scripts` followed by `npm test` to run core and runtime regressions. Dependency installation needs package-registry access; the tests consume no model or image quota.

Git tag: `v1.1.0`. Install this version with `github:donhac/dsh-magpie-discovery#v1.1.0`.

## 1.0.0

Initial release of on-demand Magpie tool discovery, bounded session selection and native-result projection validation.
