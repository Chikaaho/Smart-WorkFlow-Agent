# ZCode、DeepSeek Harness 与 OCX 接入调研

2026-10-25 调研桌面会话和浏览器，2026-11-11 补充 OCX 组合路由。接入范围仅限 ZCode 和 DeepSeek Harness 的桌面端。三种角色共用选定的宿主，页面验收要求执行子会话能操作用户可见的浏览器。派单与验收流程见[入口方案](local-harness-collaboration-plan.md)。

## OCX 自定义组合

OCX 为自定义模型组合提供公开 ID `combo/<id>`。本机 `ocx help combo set` 列出按顺序指定目标的 `--targets` 和路由策略 `--strategy`。新建组合的默认策略是 `failover`。入口可用 `ocx combo list --json` 读取当前实例已保存的组合，用 `ocx models live --json` 读取模型目录。11 月 11 日只读查询时本机代理未运行，当日的实际组合名单和故障切换尚未实测。[管理 API](https://opencodex.me/reference/management-api/)

若用户设置 A 为首选、B 为备用，并允许故障切换，A 返回限流或上游服务错误时，OCX 会在同一请求中尝试下一个符合条件的目标。普通无效参数等终止错误会直接返回。若相关策略明确关闭切换，OCX 会报告拒绝原因。Workspace 配置引用整个组合，Planner 派发的 Executor 始终使用同一个公开 ID。[组合路由](https://opencodex.me/guides/combos/) · [故障切换策略](https://opencodex.me/guides/fallback-off/)

## 桌面宿主和执行子代理

| 宿主 | 10 月调研找到的接口 | 接入时需要实测 |
|---|---|---|
| ZCode | V4 会话命令与事件订阅，模型选择包含 provider、model、reasoningLevel。浏览器工具需要插件和桌面 Host 提供 BrowserControl。当时本机安装版为 3.16.3。 | 同一宿主内 Planner 与 Executor 角色绑定、子会话模型覆盖、可见 tab、暂停和恢复。[会话协议](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/command.ts) · [子代理配置](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/subagents-types.ts) · [浏览器插件](https://github.com/zai-org/ZCode/blob/main/docs/browser-use/browser-use-plugin-runtime-boundary.md) |
| DeepSeek Harness | 桌面 Host、连接层、子代理 `agentOptions` 和浏览器 provider。10 月所查 SDK 有 prompt、resume、wait，未找到会话级取消接口。 | 发行版的桌面会话接入方式、子代理 provider 是否允许覆盖模型，以及如何仅中断本次任务并交还浏览器控制。[桌面连接层](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md) · [子代理接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) · [浏览器 provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/browser-use.md) |

OCX 已有这两种客户端的模型配置集成。实施时仍需核对桌面会话实际收到的模型或组合 ID，以及该执行会话的 MCP、可见浏览器和图像输入能力。前端验收要在用户能看到的页面执行操作并回读证据。模型目录和桌面窗口本身都无法证明这些步骤已经成功。[客户端集成](https://opencodex.me/guides/integrations/)

## 2026-10-25 本机目录快照

当次调研使用的版本为 `2.91.0`。本轮 `models live --json` 返回 619 条，18 条启用、601 条禁用，分布如下。这是模型目录事实，不是 619 个或 18 个模型均已通过真实调用验证。

| provider | 目录条目 | 启用 |
|---|---:|---:|
| openai | 8 | 8 |
| command-code | 93 | 2 |
| deepseek | 2 | 2 |
| opencode-go | 46 | 3 |
| openrouter | 459 | 2 |
| zhipu-bigmodel-coding | 11 | 1 |
| 合计 | 619 | 18 |

当时启用的公开 selector 为：

```text
gpt-5.5
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
gpt-6-astra
gpt-6-sol
gpt-6-luna
gpt-6.1-sol
command-code/claude-sonnet-5-5
command-code/deepseek-deepseek-v4.1-flash
deepseek/deepseek-flash
deepseek/deepseek-v4-flash
opencode-go/claude-haiku-5-5
opencode-go/deepseek-v4.1-flash
opencode-go/gpt-6-luna
openrouter/anthropic-claude-opus-5.5
openrouter/deepseek-deepseek-v4.1-flash
zhipu-bigmodel-coding/glm-5.3-flash
```

完整脱敏目录单独导出到本地 `opencodex-model-catalog-2026-10-25.json`，包含全部 619 条及上述状态，不含认证信息。启用条目中有的工具或图像元数据未给出，还有条目声明使用视觉 sidecar，入口应保留这些差别，不能统一标为已验证原生视觉。

对 `command-code/deepseek-deepseek-v4.1-flash` 的只读协议预览分别返回 Responses 的 `translated` 和 Messages 的 `legacy-bridge`，二者解析到上游 `deepseek/deepseek-v4.1-flash`。这证明需要逐协议解析路由；该预览没有验证真实工具调用、图像、费用或模型供应方实际执行情况。

## 2026-11-11 实机补充

本轮使用 ZCode Desktop 3.17.2、DeepSeek Harness Desktop 0.2.2-rc.1 和 OCX 2.100.1。以下结果来自真实会话和页面回读，不以目录可见或桌面窗口存在代替推理、工具和浏览器验证。

### ZCode

Pi 通过 ZCode app-server 创建会话，把模型写入 `session/create`，并响应 ZCode 发起的 `interaction/browserList`、`interaction/browserExecute`。ZCode 决定浏览器命令，Pi 在可见 Chrome 中执行。筛选“财务部”后翻到第二页，回读 `2 / 2` 和 `AP-110、AP-113、AP-116`。

模型切换分别验证了：

- `OpenCode(Chat)` → `opencode-go-chat/deepseek-v4.1-flash`
- `CommandCode(Chat)` → `new-provider/deepseek/deepseek-v4.1-flash`

两次都从 ZCode 模型选择器和新会话绑定回读实际标签。协议入口按派单为每个新会话选择模型，不依赖用户当前默认值。

运行时以 OCX 目录解析公开路由，再从 ZCode 自身 `provider_config.json` 解析实际 provider/model。Pi 每次派单前检查 `ocx status --json`；OCX CLI 缺失、代理未运行或健康检查失败时不创建 ZCode 会话。

### DeepSeek Harness

桌面 Host 提供一次性认证入口和 `/api/session/*` RPC。Pi 启动 Desktop Host 后，先调用 `session/create`，再用 `session/selectModel` 绑定并回读 `deepseek-official/deepseek-flash`、`high`，最后通过 `session/prompt` 和 `session/wait` 收取有界结果。

DeepSeek Harness 只使用自身的 `deepseek-official` provider，不读取 ZCode 中配置的 OCX 代理 provider。OCX 仍是 Pi 开始任务前的全局运行门禁，但不参与 DeepSeek Harness 会话选模。

浏览器操作插件不是桌面默认配置。固定安装 0.2.2-rc.1 的 `@deepseek-ai/dsh-browser-use` 与 `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` 后，还必须在 `cordis.patch.yml` 用 `insert` 显式挂载。遗漏 `insert` 时，依赖虽已安装，模型仍看不到 MCP 工具；该次运行未计入通过。

正确挂载后，DeepSeek 会话只调用了 `mcp__chrome-devtools-mcp__list_pages`、`navigate_page`、`take_snapshot`、`fill` 和 `click`。可见 Chromium 中完成同一筛选翻页，最终回读 `{"department":"财务部","page":"2 / 2","ids":["AP-110","AP-113","AP-116"]}`。

### 仍未通过的项目

- 当前 OCX 实例没有已保存组合，429 / 5xx 的真实组合故障切换尚未验收。
- Workspace `main` 的 `init/harness-list.json` 尚未登记 `deepseek-harness`。本轮复用了 `main` 的 Supervisor / Validator 完成协议实现，但不能把 ZCode 的初始化状态沿用给 DeepSeek；独立宿主登记与 Admin 初始化仍是交付门禁。
