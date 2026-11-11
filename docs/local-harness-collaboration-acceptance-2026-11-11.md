# 本地 Harness 协同开发验收记录

日期：2026-11-11。实现仓库：`Smart-WorkFlow-Agent`。治理读取自 `Smart-WorkFlow-Agent-Workspace` 的 `main` 隔离工作树。验收对象是 Pi 对桌面 Harness 的控制链路，不把本会话直接操作浏览器算作结果。

2026-11-12 补充运行边界：本机 `ocx 2.100.1` 已安装，`ocx status --json` 回读代理正在运行且健康检查通过。实现增加强制前置门禁；该状态不满足时，Pi 在创建 ZCode 或 DeepSeek Harness 会话前停止派单。

## 阶段结果

| 阶段 | 结果 | 行为证据 |
|---|---|---|
| P0 | 通过 | `Pi → ZCode → Browser Use` 在可见浏览器筛选财务部并翻到 `2 / 2`，编号为 `AP-110、AP-113、AP-116`。 |
| P1 | 通过 | ZCode app-server 会话由 Pi 建立；ZCode 发出浏览器命令，Pi 提供可见 Chrome；Supervisor 接受终态，Planner 复核通过。 |
| P2 | 通过 | 第一次误选研发部并返回 `AP-111、AP-114、AP-117`，Planner 按原验收项退回。第二次使用稳定的 `a2` 派单；进程恢复后沿用同一 ZCode 会话读取已完成页面状态，没有重复浏览器动作，最终通过。 |
| P3 浏览器核心 | 通过 | Pi 启动 DeepSeek Desktop Host，绑定 `deepseek-official/deepseek-flash (high)`。DeepSeek 只用 Chrome DevTools MCP 操作可见 Chromium，回读与 P0 相同。 |
| P3 治理初始化 | 未完成 | Workspace `main` 尚未登记 `deepseek-harness`，不能生成该宿主的独立 READY 初始化结果。 |

## 模型切换

ZCode 的模型选择不依赖当前默认值。Pi 可以在派单入口指定：

- `opencode`：`OpenCode(Chat) / deepseek-v4.1-flash`
- `command`：`CommandCode(Chat) / deepseek/deepseek-v4.1-flash`

实机先切到 CommandCode(Chat) 并回读标签，再切回 OpenCode(Chat) 并回读标签。单元测试同时验证两条 OCX 路由不会映射到同一个 ZCode provider。

ZCode 路由先从 OCX 目录解析，再到 ZCode 自身 `provider_config.json` 查找实际 provider/model。Pi 按 `workflow.config.yaml` 的默认 Executor 或具名 Executor 选择模型，不读取 ZCode 当前默认值作为派单依据。

2026-11-12 使用示例配置只读回测：默认 Executor 解析为 `OpenCode(Chat) / opencode-go-chat/deepseek-v4.1-flash`，具名 `ui` 解析为 `CommandCode(Chat) / new-provider/deepseek/deepseek-v4.1-flash`；同次回读的 OCX 状态为 `running=true`、`healthy=true`。

DeepSeek Harness 不复用这些 ZCode provider。其配置只接受 `deepseek-official/<model>`，通过 `session/selectModel` 绑定会话模型。适配器要求 Host 回读的 provider、model、reasoning effort 与派单一致，否则拒绝 Executor 回执。

## DeepSeek 浏览器配置

0.2.2-rc.1 的桌面默认配置没有浏览器操作 provider。本机固定安装：

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts \
  @deepseek-ai/dsh-browser-use@0.2.2-rc.1 \
  @deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp@0.2.2-rc.1
```

`~/.dsh/profiles/desktop/cordis.patch.yml` 的有效挂载为：

```yaml
- insert:
    - id: browser-use
      name: "@deepseek-ai/dsh-browser-use"
    - id: browser-use-chrome-devtools-mcp
      name: "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp"
      config:
        mode: launch
        headless: false
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

仅安装依赖、没有 `insert` 时，模型拿不到 MCP 工具。该失败路径已复现，未计入 P3 通过。

## 自动检查

- `tsc -p packages/workflow-agent/tsconfig.build.json --noEmit`：通过。
- 工作流包 7 个定向测试文件、23 个测试：通过。
- 全仓 `npm run check` 已执行。工作流相关检查通过；TypeScript 在既有 `packages/ai/test` 模型目录用例处失败，包括 Fireworks 的 `nemotron-3-ultra-nvfp4` 类型漂移和 `deepseek-v4-flash` 已更名为 `deepseek-v4.1-flash`。本次没有修改这些测试或生成目录。

## 剩余门禁

1. 在 Workspace `main` 登记 `deepseek-harness` 独立宿主，完成 Admin 适配、允许/拒绝案例和 `init/check.py --harness deepseek-harness` 的 READY 回读。
2. 为 OCX 建立真实 failover 组合，再用受控 429 / 5xx 验证同一派单内切换；当前实例没有组合，不能以单模型切换代替。
