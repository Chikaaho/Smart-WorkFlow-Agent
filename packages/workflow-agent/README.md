# @earendil-works/pi-workflow-agent

Pi 的桌面 Harness 工作流核心。它提供：

- `workflow.config.yaml` 校验、OCX 安装/运行门禁与模型路由解析；
- 需求确认、Executor 委派、退回、暂停、接管、取消和恢复状态机；
- Workspace Supervisor / Validator 事件桥接与本地运行记录；
- ZCode app-server 协议适配，由 ZCode 选择浏览器动作，Pi 提供用户可见的 Chrome；
- DeepSeek Desktop Host 协议适配，由 DeepSeek 会话调用 Chrome DevTools MCP 操作可见 Chromium。

Pi 在每次派单前执行 `ocx status --json`。CLI 缺失、代理未运行或健康检查失败时，不会创建 Harness 会话。

模型在派单时绑定。ZCode 的模型 ID 来自 OCX 目录，再映射到 ZCode 自身 `provider_config.json` 中的代理 provider；`OpenCode(Chat)` 和 `CommandCode(Chat)` 可以按配置切换，不依赖当前默认值。DeepSeek Harness 不使用这些 ZCode provider，只接受 `deepseek-official/<model>`，通过 `session/selectModel` 绑定并回读实际 provider、model 和 reasoning effort；回读不一致时拒绝 Executor 回执。

## 已验证入口

- `examples/workflow-extension/zcode-protocol-workflow.ts`：`/workflow-p1-zcode [executor-name]`
- `examples/workflow-extension/deepseek-protocol-workflow.ts`：`/workflow-p3-deepseek [executor-name]`
- `examples/workflow-extension/zcode-desktop-control.ts`：ZCode 模型选择器切换与回读探针

ZCode 使用 `workflow.config.example.yaml`；DeepSeek Harness 使用 `workflow.deepseek.config.example.yaml`。命令的可选参数是 `executors` 中的配置名，例如 `/workflow-p1-zcode ui`。

## 实机界面

下图是更新后的 ZCode 模型选择界面；用户名、本机路径、项目与会话内容已经遮盖。`OpenCode(Chat)` 与 `CommandCode(Chat)` 均配置在 ZCode 自身 provider 列表中，Pi 根据工作流配置选择并回读实际模型。

![ZCode 中的 OCX 代理模型选择](docs/images/zcode-ocx-model-switch.png)

筛选翻页验收通过时，页面保持财务部筛选并显示第二页的 `AP-110`、`AP-113`、`AP-116`：

![筛选后翻页的通过结果](docs/images/filter-pagination-accepted.png)

DeepSeek 的浏览器能力不是桌面版默认项。0.2.2-rc.1 需要在 Desktop profile 中固定安装并显式挂载 `@deepseek-ai/dsh-browser-use` 和 `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp`，将 provider 配置为 `mode: launch`、`headless: false`。未挂载时，模型不会获得 `mcp__chrome-devtools-mcp__*` 工具；不能把 Bash 或自建 CDP 脚本当作浏览器插件验收。

完整阶段结果见 [本地验收记录](../../docs/local-harness-collaboration-acceptance-2026-11-11.md)。
