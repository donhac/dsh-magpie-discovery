# dsh-magpie-discovery

为 DeepSeek Harness Agent 提供 Magpie MCP 工具按需发现。

Magpie 通过一个 MCP Hub 提供浏览器、网页搜索、GitHub、DBX 数据库、SSH 与 TapTap 等能力。DSH 原生 MCP 客户端会预先注册全部工具定义，一次请求可能带上 150 多个 schema。本插件增加一个很小的查询工具 `magpie_tools`，仅在选中后才向模型展示对应的原始 Magpie 工具。

它是可见性层，不是第二个 MCP 客户端，也不是调用转发器。选中的工具仍由 DSH 原始执行链运行，图片、结构化值、错误、审批和结果元数据保持原生行为。

**这是一个插件，不是 Agent 预设。** 它可以挂载到任何需要 Magpie 工具的预设，也可以全局启用一次。它不定义编码模式、persona、模型路由或图片工作流。

## 提供什么

- `magpie_tools`：搜索、按精确名称加载、查看状态或清空当前选择。
- 恢复、普通压缩和分叉时，从原生会话日志重建当前会话的选择。
- 使用 deny mask 控制可见性，保留原始 Magpie 定义和执行路径。
- 不新增 MCP 连接、账号存储、OAuth 配置或远端调用包装器。

## 要求

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`（已在 `0.2.1-rc.5` 验证）。
- Node.js `>=22.19.0`。
- Host 服务 `tools`、`systemPrompt`、`sessionProjections`、`agentPresets` 和 `agents`。
- Magpie 正在运行，且 DSH 已通过现有 MCP 客户端连接其 Hub。
- 有一个挂载本包的位置：预设子项，或随包安装的可选 Host 行。

本插件**不会**创建 Magpie 连接。没有配置 Magpie MCP 时，`magpie_tools` 返回空目录，其他工具仍正常工作。

## 1.2.0 变更

发现结果增加 `added`、`evicted`、`unchanged`。通过 `names` 配合 `replace: true`，可一次把阶段工具集合替换为最多 12 个精确名称；任一名称不可用时整体失败，保留原选择。继续保持紧接着的请求即可使用、原生执行与权限策略。变更和回归覆盖见 [CHANGELOG.md](./CHANGELOG.md)。

## 安装

在 Plugin Manager 中选择 **Install bundle**，输入：

```text
github:donhac/dsh-magpie-discovery
```

或使用 DSH CLI：

```sh
dsh plugin --profile <profile> add github:donhac/dsh-magpie-discovery
```

固定版本：

```text
github:donhac/dsh-magpie-discovery#v1.2.0
```

安装后的 bundle 与插件行显示名为 **dsh-magpie-discovery**。随包还会插入一个**默认禁用**的 Host 行 `magpie-tool-discovery`。在下面两种使用方式中选一种。

## 使用

### 方式 A：挂载到预设（推荐）

把本包加入 `@deepseek-ai/dsh-agent-preset` 行的 `plugins` 列表：

```yaml
- id: magpie-tool-discovery
  name: dsh-magpie-discovery
  config:
    presetId: my-preset
```

- `presetId` 必须是包含该行的预设 id。
- 它用于在 Agent 切换离开该预设时移除限制。

这种方式只影响使用该预设的 Agent；其他预设保留完整的 Magpie 工具集。

### 方式 B：启用 Host 行（全局）

在 Plugin Manager 中启用已安装的 `magpie-tool-discovery` 行。插件随后作用于该 Profile 中的所有 Agent。

**不要**同时启用 Host 行又把它挂载到预设中；那会创建两个实例，注册同名的 `magpie_tools` 和同一个投影 key。

### 查询工具

```js
magpie_tools({ query: '浏览器标签页', limit: 2 })
magpie_tools({ query: '数据库表结构' })
magpie_tools({ query: 'dbx list connections sessions read only query', limit: 6 })
magpie_tools({ query: 'nyatermSsh connection_list session_open terminal_execute', limit: 6 })
magpie_tools({ names: ['mcp__magpie__playwright__browser_tabs'] })
magpie_tools({})
magpie_tools({ reset: true })
```

- `query` 搜索名称与描述，支持英文 API 词和常见中文能力词。
- `names` 按 1–6 个精确 `mcp__magpie__...` 名称增量加载。
- 配合 `replace: true` 可用 1–12 个名称一次替换完整集合，全部名称必须存在于目录，否则保留原集合。请包含仍需清理资源的工具。`replace` 不与查询、reset 或分页参数混用。
- 成功结果包含相对前集合的 `added`、`evicted`、`unchanged`；已可见工具可直接调用，不必重复发现。
- `limit` 为 1–6，默认 3；`offset` 用于翻页。
- 空调用返回当前选择和各类服务数量。
- `reset` 清空当前选择。

识别到服务名后，结果限定在该服务内。范围内的能力词和操作词按 OR 匹配，可以分别出现在不同工具上；但每个词都必须在该范围的目录中找到匹配，否则返回空结果。无服务范围的普通关键词查询仍按 AND 匹配；多个完整操作名按 OR 匹配。完整精确工具名排在首位。

`+` 只是分隔符，不是操作符。`+dbx connection` 等泛连接查询优先返回 `list_connections`；明确请求 `create`/`add`、`duplicate`、`remove`/`delete` 时，对应写工具仍能正常检索。

成功的发现结果提交后，选中的工具会出现在**紧接着的模型请求**中，无需额外缓冲步骤或调用无关工具。已经规划在当前 assistant 步骤内的调用不会回溯获得新定义；先查询，再在下一步调用原工具。

每个会话最多保留 12 个最近选择的工具。重复选择会刷新位置，超过上限时移除最早的选择。

## 工作方式

插件只检查以 `mcp__magpie__` 开头的全局工具名，为每个 Agent 安装一条限制：

```text
deny = 当前 Magpie 目录 - 本会话已选工具
```

限制同时作用于参数展示、查找和分发。插件不会复制、包装或重新注册真实 Magpie 工具，因此实际运行的仍是原定义。

选择状态来自原生会话日志。`magpie_tools` 在工具结果的 `presentationMeta` 中写入版本标记和完整的选择后列表；host-only 会话投影只在以下条件全部满足时接受它：

- 结果属于真实的 `magpie_tools` 调用；
- source 事件与 turn/step 匹配；
- 结果是成功的 append，而不是失败、取消、pruner 替换或 fork closer；
- 元数据版本和工具名合法。

仅返回但尚未提交为工具结果的 value 不会解锁任何工具。

成功结果提交后，同步的 `session/event` 监听器读取投影并刷新 mask，使下一次工具定义 assemble 前即可得到新选择。空白 Agent 选择预设时，在 `agent-preset/selected` 提交后立即 attach，在首个模型请求前安装限制；插件挂载时也会协调已经存在的 Agent。`agent/pre-step` 仅作为兜底，不再承担正常更新的时序。

选择、限制和监听器按有序生命周期安装。卸载时先释放 Agent 策略，再移除监听器与工具，最后移除投影。切换预设时移除旧 mask，并在选择提交时挂载匹配预设的策略。这些 hook 只更新可见性，业务执行、审批、结果展示、元数据和 finalizer 仍走 DSH 原生工具链。

## 配置

| 字段 | 必要 | 含义 |
|---|---|---|
| `presetId` | 预设挂载时建议填写 | 拥有该实例的预设 id，用于在 Agent 切换预设时解除限制。 |

Host 行不需要配置，行为是全局的。预设挂载不填 `presetId` 时，会在激活时回退到当前预设身份；显式填写更稳妥，也能在组成重载后保持确定的清理行为。

## 安全与边界

- **选择不等于授权。** 其他插件的 allow/deny、guard 和审批继续生效。搜索命中只是候选，最终可调用集合是所有策略的交集。
- **读取偏好不保证只读。** 排序依据工具名和描述，不是授权策略，也不证明工具不会写入；写工具仍可被发现。
- **不是安全沙箱。** 本插件只控制模型可见的工具定义，不断开 MCP，不移除服务器说明，也不改变文件或网络权限。
- **仅限 Magpie。** 只隐藏全局 `mcp__magpie__` 名称；其他 MCP、原生工具和图片插件不受影响。
- **同名 scoped 工具。** 若其他插件把同名真实工具直接注册在 Agent 自己的 scope，DSH 的 own-scope 豁免会使本限制无法隐藏它。该拓扑不受支持。
- **原生展示模式。** 投影识别原生 `magpie_tools` 的 `tool/call` 与 `tool/result`。若预设切到 PTC，调用记录方式不同，选择不会更新。
- **按公开名称关联。** 重连后按工具名恢复，不证明远端实现仍是同一份。
- **不减少 MCP 服务器说明。** 延后 schema 不等于移除服务器自身提供的 instructions。
- **断连。** Magpie 断开后工具立即消失；已选名称保留，同名工具重新注册后恢复。
- **下一步可见。** 当前步骤新选择的工具不会回溯加入当前请求。

## 兼容性

本插件面向使用 DSH `native` 工具展示模式的预设，不要求也不提供 PTC。

生图与图片编辑不在本插件的处理范围内。Profile 中安装的图片插件继续注册自己的工具；本插件不导入、不代理、也不修改它们。

## 开发

无运行依赖、无构建步骤。安装锁定的开发依赖后，同时运行纯核心测试和运行时回归：

```sh
npm ci --ignore-scripts
npm test
```

核心测试覆盖参数校验、中英文排序、服务范围内多操作查询、未知词拒绝、连接发现与明确写意图、精确加载、分页、6/12 项上限、重置和投影状态校验。

运行时测试实例化 DSH 真实的 AgentLoop、预设注册表、工具运行时和会话投影注册表，使用脚本化 LLM adapter 与内存 fixture 工具。测试检查实际送到 adapter 的请求，覆盖空白 Agent 选预设后的首请求收起、发现后紧邻请求立即可用、关闭前无需额外打开、预设切换、保留的旧修订、日志重放、卸载和多 Agent 独立性。同时验证其他 deny/guard 继续生效，原生图片工具定义、结果元数据与 finalizer 保持原行为。测试本身不发起网络、真实 MCP、模型或图片供应商调用，不消耗图像额度；安装开发依赖需要访问包注册表。

本地试用：

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-magpie-discovery
```

修改代码后，用 Plugin Manager 移除再重新安装本地包；链接安装需要重新安装才会加载新的模块代。

## 卸载

在 Plugin Manager 移除，或：

```sh
dsh plugin --profile <profile> remove dsh-magpie-discovery
```

如果已挂载到预设，先移除对应预设行。新会话不再出现发现工具；已有会话继续持有原版本直到结束。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
