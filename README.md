# Smart-WorkFlow-Agent

Smart-WorkFlow-Agent 是基于 Pi 的本地桌面 Harness 调度器。用户在 Pi 中确认需求，运行时按配置选择 ZCode 或 DeepSeek Harness，分别调用 Executor 和 Planner 模型，在可见浏览器中执行任务、读取证据、逐项验收并继续派单。

项目由两部分组成：

| 项目 | 内容 |
|---|---|
| [Smart-WorkFlow-Agent](https://github.com/Chikaaho/Smart-WorkFlow-Agent) | Pi 运行时、OCX 模型路由、ZCode / DeepSeek Harness 协议接入、工作流状态与本地运行记录 |
| [Smart-WorkFlow-Agent-Workspace](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/tree/main) | 规则协议；`main` 分支定义 Planner、Executor、Admin、Supervisor / Validator 的权限、事件和验收流程 |

运行时读取 Workspace `main` 的治理文件。需求确认后由 Executor 执行，Supervisor 检查治理终态，Planner 根据页面行为证据决定通过或生成下一次派单；状态保存在目标项目的 `.workflow/runtime` 中。

## 开始前准备

| 需要安装 | 用途 |
|---|---|
| macOS 13+ 或 Windows 10/11 | 运行 Pi、OCX 和桌面 Harness |
| Node.js `22.19.0+` | 运行项目 |
| Google Chrome | 显示任务执行和验收页面 |
| OCX `2.100.1` | 提供模型和路由；必须保持运行 |
| ZCode Desktop 或 DeepSeek Harness Desktop | 实际执行任务 |
| [Smart-WorkFlow-Agent-Workspace](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/tree/main) | 提供规则协议、角色权限和验收流程 |

已验证的桌面版本：

- [ZCode Desktop `3.17.2`](https://github.com/zai-org/zcode/releases)
- [DeepSeek Harness Desktop `0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases)

## 安装项目

```bash
git clone https://github.com/Chikaaho/Smart-WorkFlow-Agent.git
git clone https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace.git
cd Smart-WorkFlow-Agent
npm ci --ignore-scripts
npm --prefix packages/workflow-agent run build
```

治理目录必须使用 Workspace 的 `main` 工作树：

```bash
git -C ../Smart-WorkFlow-Agent-Workspace switch main
git -C ../Smart-WorkFlow-Agent-Workspace pull --ff-only
```

安装并启动 OCX：

```bash
npm install -g @bitkyc08/opencodex@2.100.1
ocx setup
ocx start
ocx status --json
```

看到下面两个值才算启动成功：

```text
proxy.running = true
proxy.health.ok = true
```

OCX 没有启动时，Pi 不会把任务交给 ZCode 或 DeepSeek Harness。

## 安装桌面应用

选择一个桌面应用即可：

### ZCode

1. 打开 [ZCode Releases](https://github.com/zai-org/zcode/releases)。
2. 下载对应的 macOS 或 Windows 安装包。
3. 安装并启动一次 ZCode。

默认会查找这些位置：

- macOS：`/Applications/ZCode.app`
- Windows：`%LOCALAPPDATA%\Programs\ZCode`、`%ProgramFiles%\ZCode`

### DeepSeek Harness

1. 打开 [DeepSeek Harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases)。
2. 下载对应的 macOS 或 Windows 安装包。
3. 安装并启动一次 DeepSeek Harness。

默认会查找这些位置：

- macOS：`/Applications/DeepSeek Harness.app`
- Windows：`%LOCALAPPDATA%\Programs\DeepSeek Harness`、`%ProgramFiles%\DeepSeek Harness`

其他安装目录按“自定义安装目录”设置环境变量。

## 设置本机路径

把下面三个路径改成你自己的：

macOS：

```bash
export AGENT_REPO="/absolute/path/to/Smart-WorkFlow-Agent"
export TARGET_WORKSPACE="/absolute/path/to/your-project"
export SMART_WORKFLOW_GOVERNANCE_ROOT="/absolute/path/to/Smart-WorkFlow-Agent-Workspace"
export SMART_WORKFLOW_CONFIG="$TARGET_WORKSPACE/workflow.config.yaml"
```

Windows PowerShell：

```powershell
$env:AGENT_REPO = "C:\path\to\Smart-WorkFlow-Agent"
$env:TARGET_WORKSPACE = "C:\path\to\your-project"
$env:SMART_WORKFLOW_GOVERNANCE_ROOT = "C:\path\to\Smart-WorkFlow-Agent-Workspace"
$env:SMART_WORKFLOW_CONFIG = "$env:TARGET_WORKSPACE\workflow.config.yaml"
```

- `AGENT_REPO`：本仓库路径。
- `TARGET_WORKSPACE`：要处理的项目路径。
- `SMART_WORKFLOW_GOVERNANCE_ROOT`：[Workspace 规则协议](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/tree/main)的 `main` 工作树路径。

## 使用 ZCode

### 1. 在 ZCode 中准备模型

先在 ZCode 的模型设置中加入要使用的 OCX 模型服务。当前已经验证：

| 在配置文件中填写 | ZCode 中选择 |
|---|---|
| `opencode-go/deepseek-v4.1-flash` | `OpenCode(Chat) / deepseek-v4.1-flash` |
| `command-code/deepseek-deepseek-v4.1-flash` | `CommandCode(Chat) / deepseek/deepseek-v4.1-flash` |

![在 ZCode 中选择 OpenCode 或 CommandCode](packages/workflow-agent/docs/images/zcode-ocx-model-switch.png)

### 2. 复制 ZCode 配置

```bash
cp "$AGENT_REPO/examples/workflow-extension/workflow.config.example.yaml" \
  "$TARGET_WORKSPACE/workflow.config.yaml"
```

默认配置使用 OpenCode(Chat)。运行命令时加上 `ui`，会改用 CommandCode(Chat)：

```yaml
schemaVersion: 1
harness: zcode
modelGateway:
  type: opencodex
  required: true
  installIfMissing: false

roles:
  planner:
    model: opencode-go/deepseek-v4.1-flash
  executor:
    model: opencode-go/deepseek-v4.1-flash
  admin:
    model: opencode-go/deepseek-v4.1-flash

executors:
  ui:
    model: command-code/deepseek-deepseek-v4.1-flash
```

模型账号和密钥保存在 OCX 与 ZCode 中，`workflow.config.yaml` 只保存模型路由。

### 3. 启动 ZCode 工作流

```bash
cd "$TARGET_WORKSPACE"
"$AGENT_REPO/pi-test.sh" \
  --extension "$AGENT_REPO/examples/workflow-extension/zcode-protocol-workflow.ts"
```

Windows PowerShell：

```powershell
Set-Location $env:TARGET_WORKSPACE
& "$env:AGENT_REPO\pi-test.ps1" `
  --extension "$env:AGENT_REPO\examples\workflow-extension\zcode-protocol-workflow.ts"
```

进入 Pi 后，使用默认模型运行：

```text
/workflow-p1-zcode
```

使用 CommandCode(Chat) 的 DeepSeek 运行：

```text
/workflow-p1-zcode ui
```

Pi 会检查 OCX，读取配置，在 ZCode 中选择 Executor 模型并执行任务。Executor 返回后，Pi 会再创建使用 `roles.planner` 模型的 ZCode 会话，独立读取当前页面并逐项验收。未通过时，Planner 的修复要求会直接成为下一次 Executor 派单。

### 4. 单独测试模型切换（macOS）

启动模型切换工具：

```bash
cd "$TARGET_WORKSPACE"
"$AGENT_REPO/pi-test.sh" \
  --extension "$AGENT_REPO/examples/workflow-extension/zcode-desktop-control.ts"
```

进入 Pi 后运行：

```text
/harness-zcode-model-switch OpenCode(Chat)/deepseek-v4.1-flash
/harness-zcode-model-switch CommandCode(Chat)/deepseek/deepseek-v4.1-flash
```

需要同时验证模型确实能回复时运行：

```text
/harness-zcode-model-probe CommandCode(Chat)/deepseek/deepseek-v4.1-flash
```

这组命令通过 macOS 辅助功能检查 ZCode 模型选择器。Windows 主工作流在 `session/create` 时绑定并回读模型。

如果 macOS 拒绝控制 ZCode，请到“系统设置 → 隐私与安全性 → 辅助功能”中允许运行 Pi 的终端应用，然后重启 Pi。

## 使用 DeepSeek Harness

DeepSeek Harness 只使用它自己的 DeepSeek 模型，不读取 ZCode 中的 OpenCode(Chat) 或 CommandCode(Chat)。

### 1. 安装浏览器插件

先在 DeepSeek Harness 的 `Manage dsh Command…` 中选择 `Install`，新开终端确认 `dsh --version` 可用，再执行：

```bash
dsh plugin --profile desktop add --save-exact --ignore-scripts \
  @deepseek-ai/dsh-browser-use@0.2.2-rc.1 \
  @deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp@0.2.2-rc.1
```

打开配置文件：

- macOS：`~/.dsh/profiles/desktop/cordis.patch.yml`
- Windows：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`

加入：

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

Windows 把最后一行改为：

```yaml
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
```

如果 Chrome 安装在当前用户目录，则使用 `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` 展开后的绝对路径。

保存后重启 DeepSeek Harness。

### 2. 复制 DeepSeek 配置

```bash
cp "$AGENT_REPO/examples/workflow-extension/workflow.deepseek.config.example.yaml" \
  "$TARGET_WORKSPACE/workflow.config.yaml"
```

配置中的模型保持为：

```yaml
roles:
  planner:
    model: deepseek-official/deepseek-flash
  executor:
    model: deepseek-official/deepseek-flash
  admin:
    model: deepseek-official/deepseek-flash

executors:
  ui:
    model: deepseek-official/deepseek-flash
```

### 3. 启动 DeepSeek Harness 工作流

```bash
cd "$TARGET_WORKSPACE"
"$AGENT_REPO/pi-test.sh" \
  --extension "$AGENT_REPO/examples/workflow-extension/deepseek-protocol-workflow.ts"
```

Windows PowerShell：

```powershell
Set-Location $env:TARGET_WORKSPACE
& "$env:AGENT_REPO\pi-test.ps1" `
  --extension "$env:AGENT_REPO\examples\workflow-extension\deepseek-protocol-workflow.ts"
```

进入 Pi 后运行：

```text
/workflow-p3-deepseek
```

或：

```text
/workflow-p3-deepseek ui
```

DeepSeek Harness 会打开可见 Chromium。Executor 完成页面操作后，Planner 会通过同一套浏览器插件独立验收；未通过时自动继续派单，每轮最多 60 次。额度用完后，Pi 会显示累计派单、最近一次 Planner 结论和未通过项，再询问是否继续。

## 跑一遍自带示例

自带示例用于检查“筛选后翻页”是否正常。

### 1. 启动测试页面

另开一个终端：

```bash
cd "$AGENT_REPO/examples/workflow-extension"
python3 -m http.server 4173
```

Windows PowerShell：

```powershell
Set-Location "$env:AGENT_REPO\examples\workflow-extension"
py -m http.server 4173
```

测试页面地址：

```text
http://127.0.0.1:4173/p0-filter-pagination-demo.html
```

### 2. 运行任务

使用前面的 ZCode 或 DeepSeek Harness 启动命令，然后在 Pi 中运行对应命令。

macOS 的 ZCode 桌面 Browser Use 探针还可以直接运行：

```text
/harness-p0-zcode
```

如果 ZCode 正在等待浏览器授权：

```text
/harness-zcode-approve-browser
```

### 3. 检查结果

通过时，页面应停在财务部第二页，并显示三条记录：

![财务部筛选后的第二页](packages/workflow-agent/docs/images/filter-pagination-accepted.png)

Pi 返回的内容应包含：

```json
{
  "department": "财务部",
  "page": "2 / 2",
  "ids": ["AP-110", "AP-113", "AP-116"]
}
```

通过条件包括正确的页面操作、最终页面状态和 Pi 返回结果。

## 一次任务会怎么运行

1. 你在 Pi 中运行 ZCode 或 DeepSeek Harness 命令。
2. Pi 检查 OCX、配置文件和本机应用，并恢复 `.workflow/runtime` 中已有的运行记录。
3. Executor 在可见浏览器中执行操作并返回回执。
4. Workspace Supervisor 检查治理事件和回执是否允许进入业务验收。
5. Pi 使用 `roles.planner` 配置的模型创建独立 Planner 会话；Planner 必须读取当前页面，逐项给出证据。
6. 任一条件未通过时，Planner 生成下一张 Executor 派单，运行时继续执行；每轮默认和最高上限均为 60 次。
7. 本轮额度用完后，Pi 汇报累计派单、Planner 结论和未通过项。选择继续后输入 1–60 的新增轮数；新额度用完时再次汇报并询问。
8. 全部条件通过后任务进入 `accepted`；用户选择终止时进入 `cancelled`。每次派单、暂停、恢复和验收结果都会写入本地运行记录。

你可以随时切到浏览器或桌面应用查看过程，也可以暂停后接管。

## 当前可用范围

- macOS：ZCode 模型切换、DeepSeek 原生模型、可见浏览器、任务退回、暂停和恢复已完成实机验证。
- 运行时：Executor 与 Planner 使用各自配置的模型；Planner 逐项验收并自动退回，运行记录支持恢复和单写入锁。
- Windows：已实现 PowerShell 启动、Chrome/ZCode/DeepSeek Harness 默认安装目录发现和自定义目录覆盖；仍需在 Windows 实机完成同一套“筛选后翻页”验收。
- DeepSeek Harness 独立接入 Workspace 规则仓库的初始化登记仍待完成。
- 当前命令主要用于跑通仓库内置验收示例；接入实际项目时，需要按业务任务修改需求和验收项。

## 常见问题

### 提示 OCX 没有运行

```bash
ocx status --json
ocx start
```

确认 `proxy.running` 和 `proxy.health.ok` 都是 `true`。

### ZCode 找不到模型

先确认 OCX 中存在该模型：

```bash
ocx models live --json
```

再打开 ZCode 模型设置，确认对应的 OpenCode(Chat) 或 CommandCode(Chat) 已启用。

### ZCode 不能操作窗口

打开“系统设置 → 隐私与安全性 → 辅助功能”，允许运行 Pi 的终端应用，然后重新启动 Pi。

这项用于 macOS 界面探针；Windows 主协议工作流通过会话协议绑定模型。

### 应用或 Chrome 安装在其他目录

macOS 用 `export`，Windows PowerShell 用 `$env:变量名 = "路径"` 设置：

| 变量 | 内容 |
|---|---|
| `SMART_WORKFLOW_CHROME_EXECUTABLE` | `chrome.exe` 或 macOS Chrome 可执行文件的完整路径 |
| `SMART_WORKFLOW_ZCODE_RESOURCES` | ZCode 的 `resources` 目录 |
| `SMART_WORKFLOW_ZCODE_PERSONAL_PROVIDER_CONFIG` | ZCode 的 `provider_config.json` 完整路径 |
| `SMART_WORKFLOW_DEEPSEEK_INSTALL_DIR` | 包含 `DeepSeek Harness.exe` 的安装目录，或 macOS `.app` 路径 |
| `SMART_WORKFLOW_DEEPSEEK_EXECUTABLE` | DeepSeek Harness 可执行文件完整路径 |
| `SMART_WORKFLOW_DEEPSEEK_RESOURCES` | DeepSeek Harness 的 `resources` 目录 |

### DeepSeek Harness 没有浏览器工具

确认两个浏览器插件已经安装，`cordis.patch.yml` 中存在 `insert` 配置，然后重启 DeepSeek Harness。

### 找不到 Workspace 规则

确认下面的环境变量指向规则仓库的 `main` 工作树：

```bash
echo "$SMART_WORKFLOW_GOVERNANCE_ROOT"
```

### 4173 端口被占用

停止旧的测试服务，再重新执行：

```bash
python3 -m http.server 4173
```

## 开发者检查

```bash
npm --prefix packages/workflow-agent test
npx tsc -p packages/workflow-agent/tsconfig.build.json --noEmit
npm run check:pinned-deps
```

当前工作流包有 10 个测试文件、39 个测试。完整设计和验收记录：

- [实施方案](docs/local-harness-collaboration-plan.md)
- [实机验收记录](docs/local-harness-collaboration-acceptance-2026-11-11.md)
- [桌面应用与模型调研](docs/desktop-harness-model-capabilities-research.md)
- [工作流包说明](packages/workflow-agent/README.md)

## 数据与隐私

- 不要把模型账号、令牌或 API Key 写入 `workflow.config.yaml`。
- `.workflow/` 是本机运行数据，不要提交。
- README 中的桌面截图已经移除用户名、本机路径、项目名和会话内容。

## 上游项目

本项目基于 [earendil-works/pi](https://github.com/earendil-works/pi) fork 开发，并保留上游提交历史。

## License

MIT
