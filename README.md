# Smart-WorkFlow-Agent

Smart-WorkFlow-Agent 是基于 Pi 的本地桌面 Harness 调度器。它为每个项目创建独立的本地 Workspace，使用 OCX 配置角色模型，再由 ZCode 或 DeepSeek Harness 完成规划、执行、验收、状态同步、提交和推送。

项目由两部分组成：

| 项目 | 内容 |
|---|---|
| [Smart-WorkFlow-Agent](https://github.com/Chikaaho/Smart-WorkFlow-Agent) | Pi 执行器、OCX 模型路由、ZCode / DeepSeek Harness 协议接入和工作流运行时 |
| [Smart-WorkFlow-Agent-Workspace](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/tree/main) | 通用 Workspace 模板；`main` 定义 Planner、Executor、Admin、Supervisor / Validator 的权限、事件和验收流程 |

Pi 默认把启动目录作为 `project-dir`。首次运行 `/init` 时，它从通用 Workspace `main` 创建 `<project-dir>/.workflow/workspace`，让 Executor 根据用户提供的材料和项目代码初始化 `project.md`、`knowledge/` 和 `memory/`。此后该项目只使用自己的本地 Workspace；运行记录保存在 `<project-dir>/.workflow/runtime`。

Pi 只是执行器。项目配置、Workspace 和运行状态都由项目目录持有，不写入 Pi 的安装目录，也不通过全局变量绑定项目。

## 开始前准备

| 需要安装 | 用途 |
|---|---|
| macOS 13+ 或 Windows 10/11 | 运行 Pi、OCX 和桌面 Harness |
| Node.js `22.19.0+` | 运行项目 |
| Google Chrome | 显示任务执行和验收页面 |
| OCX `2.100.1` | 提供模型和路由；必须保持运行 |
| ZCode Desktop 或 DeepSeek Harness Desktop | 实际执行任务 |
| [Smart-WorkFlow-Agent-Workspace](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/tree/main) | `/init` 自动读取的通用 Workspace 模板 |

已验证的桌面版本：

- [ZCode Desktop `3.17.2`](https://github.com/zai-org/zcode/releases)
- [DeepSeek Harness Desktop `0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases)

## 安装项目

```bash
git clone https://github.com/Chikaaho/Smart-WorkFlow-Agent.git
cd Smart-WorkFlow-Agent
npm ci --ignore-scripts
npm --prefix packages/workflow-agent run build
```

仓库根目录提供两个启动入口：

- macOS / Linux：`smart-workflow.sh`
- Windows PowerShell：`smart-workflow.ps1`

启动入口只加载 Pi 和 Smart-WorkFlow 扩展，当前终端所在目录仍是项目目录。

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

## 项目目录

每个项目使用自己的配置和 Workspace：

```text
your-project/
├── workflow.config.yaml
└── .workflow/
    ├── workspace/
    ├── runtime/
    └── supervisor/
```

- `workflow.config.yaml`：选择 Harness、角色模型和具名 Executor。
- `.workflow/workspace`：`/init` 从 [Smart-WorkFlow-Agent-Workspace main](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/tree/main) 创建的项目 Workspace。
- `.workflow/runtime`：任务状态、Executor 回执和 Planner 验收记录。
- `.workflow/supervisor`：Supervisor / Validator 的本地状态。

Pi 启动时使用当前目录。需要切换项目时运行 `/project-dir <路径>`；Pi 不保存全局项目路径。测试本地 Workspace 模板时，可临时设置 `SMART_WORKFLOW_TEMPLATE` 为另一个 Git 仓库地址或本地 Git 目录。

## 使用 ZCode

### 1. 在 ZCode 中准备模型

先在 ZCode 的模型设置中加入要使用的 OCX 模型服务。当前已经验证：

| 在配置文件中填写 | ZCode 中选择 |
|---|---|
| `opencode-go/deepseek-v4.1-flash` | `OpenCode(Chat) / deepseek-v4.1-flash` |
| `command-code/deepseek-deepseek-v4.1-flash` | `CommandCode(Chat) / deepseek/deepseek-v4.1-flash` |

![在 ZCode 中选择 OpenCode 或 CommandCode](packages/workflow-agent/docs/images/zcode-ocx-model-switch.png)

### 2. 复制 ZCode 配置

macOS / Linux：

```bash
cd /absolute/path/to/your-project
cp /absolute/path/to/Smart-WorkFlow-Agent/examples/workflow-extension/workflow.config.example.yaml \
  ./workflow.config.yaml
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\your-project
Copy-Item C:\path\to\Smart-WorkFlow-Agent\examples\workflow-extension\workflow.config.example.yaml `
  .\workflow.config.yaml
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

也可以在 ZCode 中只配置一个统一的 `ocx` provider：Base URL 使用 `http://localhost:10100/v1`，API 格式选择 Responses，再加入 OCX 返回的完整公开 selector。Pi 会优先选择完整 selector，并按模型实际支持的推理档位创建会话。

Executor 默认使用 `high` 推理档位，Planner 默认使用 `medium`；ZCode 不接受默认值时自动选择兼容档位。

### 3. 启动 ZCode 工作流

```bash
cd /absolute/path/to/your-project
/absolute/path/to/Smart-WorkFlow-Agent/smart-workflow.sh
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\your-project
& "C:\path\to\Smart-WorkFlow-Agent\smart-workflow.ps1"
```

首次进入项目先初始化本地 Workspace。Pi 会提示输入项目说明、材料路径或文档链接：

```text
/init
```

也可以从任意目录启动 Pi，再切换项目目录：

```text
/project-dir /absolute/path/to/your-project
/init
```

`/init /absolute/path/to/your-project` 可以一次完成目录切换并开始初始化。相对路径以当前 `project-dir` 为起点。选择结果保存在当前 Pi 会话中，后续 `/workflow-setup` 和 `/workflow` 都使用该目录。

然后查看安装、账号、模型和项目 Workspace 状态：

```text
/workflow-setup
```

开始通用任务：

```text
/workflow
```

需要指定具名 Executor 时把配置名作为参数，例如使用 CommandCode(Chat) 的 `ui`：

```text
/workflow ui
```

Pi 会让你输入任务，使用 `roles.planner` 生成目标、验收条件和 Executor 派单。确认规划后自动执行；Planner 退回时继续修复。任务产生仓库变更时，状态同步、提交和推送属于验收条件。

Pi 创建和恢复 ZCode 会话时会自动选择“完全操控”（`yolo`）。执行过程中不会逐项询问工具权限；任务规划确认和需要用户决策的节点仍会停下来询问。

### 4. 单独测试模型切换（macOS）

启动模型切换工具：

```bash
cd /absolute/path/to/your-project
/absolute/path/to/Smart-WorkFlow-Agent/pi-test.sh \
  --extension /absolute/path/to/Smart-WorkFlow-Agent/examples/workflow-extension/zcode-desktop-control.ts
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

macOS / Linux：

```bash
cd /absolute/path/to/your-project
cp /absolute/path/to/Smart-WorkFlow-Agent/examples/workflow-extension/workflow.deepseek.config.example.yaml \
  ./workflow.config.yaml
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\your-project
Copy-Item C:\path\to\Smart-WorkFlow-Agent\examples\workflow-extension\workflow.deepseek.config.example.yaml `
  .\workflow.config.yaml
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
cd /absolute/path/to/your-project
/absolute/path/to/Smart-WorkFlow-Agent/smart-workflow.sh
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\your-project
& "C:\path\to\Smart-WorkFlow-Agent\smart-workflow.ps1"
```

进入 Pi 后运行：

```text
/init
/workflow-setup
/workflow
```

使用具名 Executor：

```text
/workflow ui
```

DeepSeek Harness 会打开可见 Chromium。Executor 完成页面操作后，Planner 会通过同一套浏览器插件独立验收；未通过时自动继续派单，每轮最多 60 次。额度用完后，Pi 会显示累计派单、最近一次 Planner 结论和未通过项，再询问是否继续。

Pi 创建 DeepSeek 会话时会自动选择“完全权限”（`danger-full-access`）并回读确认，不会逐项询问工具权限。

## 跑一遍自带示例

自带示例用于检查“筛选后翻页”是否正常。

### 1. 启动测试页面

另开一个终端：

```bash
cd /absolute/path/to/Smart-WorkFlow-Agent/examples/workflow-extension
python3 -m http.server 4173
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\Smart-WorkFlow-Agent\examples\workflow-extension
py -m http.server 4173
```

测试页面地址：

```text
http://127.0.0.1:4173/p0-filter-pagination-demo.html
```

### 2. 运行任务

通用入口使用 `/workflow`。需要单独复测仓库内置场景时，改为加载对应的示例扩展：

```bash
/absolute/path/to/Smart-WorkFlow-Agent/pi-test.sh \
  --extension /absolute/path/to/Smart-WorkFlow-Agent/examples/workflow-extension/zcode-protocol-workflow.ts
```

或加载 `deepseek-protocol-workflow.ts`，再运行 `/workflow-p1-zcode [executor-name]` 或 `/workflow-p3-deepseek [executor-name]`。

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

1. Pi 把启动目录作为 `project-dir`。需要处理其他目录时运行 `/project-dir <path>`；也可以直接运行 `/init <path>`。
2. Pi 检查该目录的 `workflow.config.yaml`、项目本地 Workspace，以及 OCX、Chrome、ZCode、DeepSeek Harness 和三种角色模型。
3. 新项目运行 `/init`，输入项目材料。Pi 从通用模板创建 `.workflow/workspace`，Executor 读取材料和项目代码并初始化项目知识。
4. 运行 `/workflow`。如果存在未完成记录，先恢复或终止；否则输入新任务。
5. Planner 读取项目 Workspace 中的事实，生成目标、验收条件、具名 Executor 和完整派单。你确认后才开始执行；修改任务会重新规划。
6. Executor 在项目目录完成实现和验证，Workspace Supervisor 检查回执能否进入业务验收。
7. Planner 独立读取工程和页面行为证据，逐项验收。退回意见自动成为下一次 Executor 派单。
8. 每轮默认和最高上限为 60 次。额度用完后，Pi 汇报累计派单、Planner 结论和未通过项；选择继续后输入 1–60 的新增轮数。
9. 验收通过前，Executor 按项目 Workspace 同步后续状态、验收回执和终态；产生仓库变更时提交本任务文件并推送当前远端分支。
10. Planner 核对状态同步、提交、推送和工作树结果。全部通过后保存并显示 `accepted`；用户终止时保存 `cancelled`。

你可以随时切到浏览器或桌面应用查看过程，也可以暂停后接管。

## 当前可用范围

- macOS：ZCode 模型切换、DeepSeek 原生模型、可见浏览器、任务退回、暂停和恢复已完成实机验证。
- 运行时：`/init` 项目 Workspace 初始化、启动体检、通用任务规划确认、Executor / Planner 自动循环、轮次续跑、状态同步、Git 提交推送验收、未完成任务恢复和单写入锁已接入统一入口。
- Windows：已实现 PowerShell 启动、Chrome/ZCode/DeepSeek Harness 默认安装目录发现和自定义目录覆盖；仍需在 Windows 实机完成同一套“筛选后翻页”验收。
- `/workflow-p1-zcode` 和 `/workflow-p3-deepseek` 保留为固定验收示例；实际项目使用 `/workflow`。

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
| `SMART_WORKFLOW_HARNESS_TIMEOUT_MS` | 单次 Planner、Executor 或验收等待时间，默认 `900000`（15 分钟），最小 `60000` |

### DeepSeek Harness 没有浏览器工具

确认两个浏览器插件已经安装，`cordis.patch.yml` 中存在 `insert` 配置，然后重启 DeepSeek Harness。

### 项目 Workspace 未初始化

在目标项目中重新启动 Pi，然后运行：

```text
/init
```

输入项目说明、已有文档路径或链接。成功后会生成 `<项目>/.workflow/workspace`。如果该目录已存在但初始化未完成，Pi 会拒绝覆盖；删除或迁移该目录后再重新初始化。

### 从其他目录启动 Pi

运行 `/project-dir <项目路径>` 切换 Smart-WorkFlow 的执行目录，再运行 `/init`、`/workflow-setup` 或 `/workflow`。也可以直接运行 `/init <项目路径>`。切换后，配置固定读取 `<项目>/workflow.config.yaml`，Workspace 和运行状态固定写入 `<项目>/.workflow/`。

### 4173 端口被占用

停止旧的测试服务，再重新执行：

```bash
python3 -m http.server 4173
```

## 开发者检查

```bash
npm --prefix packages/workflow-agent test
npx tsc -p packages/workflow-agent/tsconfig.build.json --noEmit
npx tsc -p examples/workflow-extension/tsconfig.json
npm run check:pinned-deps
```

完整设计和验收记录：

- [实施方案](docs/local-harness-collaboration-plan.md)
- [实机验收记录](docs/local-harness-collaboration-acceptance-2026-11-11.md)
- [桌面应用与模型调研](docs/desktop-harness-model-capabilities-research.md)
- [工作流包说明](packages/workflow-agent/README.md)

## 数据与隐私

- 不要把模型账号、令牌或 API Key 写入 `workflow.config.yaml`。
- `.workflow/` 保存项目本地 Workspace 和运行数据，不要加入项目代码仓提交。
- README 中的桌面截图已经移除用户名、本机路径、项目名和会话内容。

## 上游项目

本项目基于 [earendil-works/pi](https://github.com/earendil-works/pi) fork 开发，并保留上游提交历史。

## License

MIT
