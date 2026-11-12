# 桌面 Harness 协同开发入口 · 实施与验收方案

2026-11-11 建立方案，2026-11-12 完成通用入口。实现仓库为 `Smart-WorkFlow-Agent` 的 `main`，治理依据为 `Smart-WorkFlow-Agent-Workspace` 的 `main`。当前实现包括[通用 Pi 入口](../examples/workflow-extension/smart-workflow.ts)、[配置示例](../examples/workflow-extension/workflow.config.example.yaml)、OCX 与角色模型门禁、ZCode / DeepSeek Harness 适配、Planner / Executor 循环、可见浏览器验收、运行记录恢复、状态同步及 Git 提交推送验收。

## 一、用户操作与完成条件

用户在一个 Workspace 里选 **ZCode 桌面端或 DeepSeek Harness 桌面端**。同一需求的所有角色、子会话、浏览器操作都归这个宿主。OCX 是 Pi 的强制启动前置条件：CLI 必须已安装，代理必须正在运行且健康检查通过，否则 Pi 不创建 Harness 会话、不派单。浏览器必须在用户桌面可见、可交互，用户能够接管。

两款宿主的选模边界不同。ZCode 使用其自身模型配置中已经接入的 OCX 代理 provider，Pi 根据 `workflow.config.yaml` 选择或切换具体 provider/model，不依赖 ZCode 当前默认值。DeepSeek Harness 只使用自身的 DeepSeek provider，不读取或复用 ZCode 中的 OCX provider。

1. 打开 Workspace。入口显示选定的桌面端、连接状态、浏览器是否可操作、三种角色的模型。用户可以查看 OCX 的全部目录、只看已启用项或选择组合。依赖准备和治理初始化通过后，进入 Planner 会话。
2. 用户与 Planner 讨论需求。Planner 展示范围、验收项、需要用户裁决的节点。用户确认当前版本后，入口记录这次确认以及在该范围内派发 Executor 的授权。确认前不发执行单。
3. Planner 把下一项工作交给具名执行子代理，或使用默认 Executor。执行单写明操作对象、预期行为、完成条件及所需工具。Executor 在同一桌面宿主内读代码、修改、自验，按工作项返回行为证据。
4. 执行回合结束后，由 Workspace Supervisor 和 Validator 检查能否提交执行结果。Planner 收到有效回执，对照验收项决定通过、派下一项或退回某个缺口。**派发 → 执行 → 复核**持续到已确认的需求收尾。组合内部切换备用模型属于同一次模型请求，业务验收退回才产生修复派单。
5. 用户可以随时补充、暂停、接管、继续或取消。补充默认归入当前需求。实质改变目标或授权范围时，Planner 展示改动，更新确认后处理受影响的工作。验收权可按授权委托 Planner，保留人工验收的项目在该节点向用户展示已验证项、待决项和原始证据。
6. 界面分别显示功能是否通过和整个交付是否结束。对遵循 Workspace `main` 默认规则的新需求，依次执行评估、开发分支实施、验收同步、合入 `develop` 再合入 `main`、按用户确认的版本发布、发布后同步、结束。用户明确本次不发版时，按规则在验收同步后结束。开发工具的阶段与项目交付的七个阶段分别记录。[生命周期 §3.0](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/system.md)

**贯穿开发的示例。** 用户确认「审批列表选好部门后，翻到第二页仍按该部门筛选」。Planner 派 `ui` 执行，Executor 在用户可见的标签页操作并读回页码、筛选值和列表记录。第一页已通过、第二页混入其他部门时，Planner 仅派回翻页缺口。修复后在相同条件下复验，再按授权完成验收和同步。

## 二、Workspace main 的复用与适配

| 由谁负责 | 实现依据与边界 |
|---|---|
| Workspace | `system.md`、`roles/` 和目标项目的 `project.md` 决定授权、读写范围、工程仓库及验收规则。初始化先对实际宿主运行只读的 `python3 init/check.py --harness <已登记的宿主 ID>`。只有该宿主的状态可用于本次运行。新增宿主、角色委派来源或通用 Hook 时，由 Admin 按初始化规范维护并验证。[初始化](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/init/README.md) |
| Planner | 负责方向、派单、第一层验收。按角色权限读取行为证据。需要代码事实时经 `search_task/ → Executor → search_fallback/`。L/XL 用 `product/` 下发方向并记录独立验收。[角色定义](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/roles/planner.md) |
| Executor | 依据工程事实判级，按授权修改和验证，回传结果。功能通过后先更新 `knowledge/`，再按 Planner 的同步清单更新获授权摘要。任一子代理沿用 Executor 权限。[角色定义](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/roles/executor.md) |
| Admin | 维护初始化、权限、Hook 和宿主适配配置。日常开发循环只需 Planner 和 Executor。管理员有独立模型和会话，不参与业务验收。[角色定义](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/roles/admin.md) |
| Supervisor / Validator | 复用 `main` 已有的事件、决定、租约和唯一 Executor 终态契约。入口提供宿主观察，把裁决送回具体会话。Supervisor 决定执行能否收尾，Planner 依据业务行为裁决验收。[Host Adapter 契约](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/.codex/governance/host-adapter-contract.md) · [Supervisor 实现](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/.codex/governance/execution-supervisor.py) · [终态契约](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/.codex/governance/terminal-contract.json) |

**两处需要在实现时明确衔接。** 第一，`main` 要求每个会话有用户明确指定的唯一角色。入口在用户开启规划会话时绑定 Planner，在确认需求时登记对本需求执行子会话的授权。每次派单据此绑定 Executor。若原生子代理只能继承父角色，使用同一桌面宿主内独立绑定的 Executor 会话，以任务 ID 关联父单。先让 Admin 在基于 `main` 的治理适配中接纳、验证这一授权来源，再启用自动执行。Planner 提示词和 YAML 均不能授予执行权限。

第二，`main` 原有 S/M 路径允许用户直派 Executor，而本产品明确要求需求先确认、再由 Planner 派单。把这条产品路由作为桌面入口的治理适配。S/M 保留轻量记录和验证，Planner 根据结果安排下一项或向用户交付；正式功能级审查、状态登记与终态同步按 L/XL 规则触发。用一条 S 级修改和一条 L 级页面需求分别验收，避免误把所有需求升级。[分级与路由 §0.3、§3.1–3.4](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/system.md)

**退回规则按 `main` §3.6。** 同项重复失败时先自查验收口径、读取方法和已有证据。明确缺陷仍在授权内就继续修复，包括第三轮及以后。每轮说明原对象、实际与预期差异、收窄的修改范围和完成断言。保留失败历史和已通过项；出现相关改动、新反证或原快照失效才重验。仅剩无法自行消解的证据小问题时，列出影响和未验证边界交用户裁决。目标变更、风险接受或真正缺少外部输入也交用户决定。[第一层验收规则](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/roles/planner.md)

## 三、配置、模型目录与派单选模

配置放在目标 Workspace 根目录的 `workflow.config.yaml`。完整字段见[示例 YAML](../examples/workflow-extension/workflow.config.example.yaml)。`combo/coding` 和 `combo/ui` 是示例名称，开发演练时替换成实际 OCX 实例中的组合。

| 配置 | 解析和生效时机 |
|---|---|
| `schemaVersion`、`harness` | 首版采用版本 1。宿主只接受 `zcode`、`deepseek-harness` 两种桌面绑定，作用于整条需求。 |
| `modelGateway` | OpenCodex 必装且必须运行。`required` 固定为 `true`。Pi 在派单前读取 `ocx status --json`，CLI 缺失、代理未运行或健康检查失败均停止任务并给出恢复命令。Workspace 的只读初始化检查与安装、启动操作分开。 |
| `roles.{planner,executor,admin}.model` | ZCode 填 OCX 的公开模型 ID 或 `combo/<id>`，解析后再到 ZCode 自身模型配置中查找实际 provider/model。DeepSeek Harness 填 `deepseek-official/<model>`，不得引用 ZCode 的 OCX provider。 |
| `executors.<name>.model` | 可选的具名执行配置。派单模型的优先级为本次明确指定、具名配置、当前 Executor 默认绑定。ZCode 可借此在 OpenCode(Chat)、CommandCode(Chat) 等已配置代理间切换；DeepSeek Harness 仍只能选择自身 DeepSeek 模型。 |

加载时校验角色、宿主、字段类型和目录引用。没有相应组合、条目已禁用、桌面会话无法使用某路由时，指出具体配置项和受影响的动作。配置变更在下一次创建会话或明确重绑后生效。在途请求用派单时登记的公开 ID。界面同时给出请求路由与可观察的实际目标，无法确认上游时保留「未知」。

读取 `ocx models live --json` 和 `ocx combo list --json`，保留完整目录与启用状态。账号、凭据、组合成员和顺序都由 OCX 管理。组合采用 `failover` 且策略允许时，首选目标遇到限流或上游故障，OCX 会尝试下一个合格目标。入口仍记录同一派单和同一组合 ID。全部不可用或返回终止错误时，保留代理原始原因和未完成项，恢复前核对之前的工程动作。[OCX 组合说明](https://opencodex.me/guides/combos/) · [管理 API](https://opencodex.me/reference/management-api/)

## 四、代码落点与接口

建议先在 `packages/workflow-agent/` 实现可独立验证的 TypeScript 模块，在现有 `examples/workflow-extension/` 放薄入口和配置示例。开发顺序建议先 ZCode 后 DeepSeek，两者分别完成相同的实机验收。文件名与入口交互形式属于实现建议，核心流程和桌面约束是产品要求。

| 模块（拟新增） | 输入 | 输出和复用位置 |
|---|---|---|
| `config.ts`、`ocx.ts` | 配置、宿主、实时模型与组合目录 | 生效的角色模型、具名执行配置、逐字段错误。仓库已有固定版本的 YAML 依赖；由使用它的包声明运行时依赖。[仓库清单](../package.json) |
| `desktop/zcode.ts`、`desktop/deepseek.ts` | 桌面实例、Workspace、角色声明、模型、派单 | 创建或恢复准确会话，发送、订阅、回读、中断。返回宿主会话和浏览器标签页标识。ZCode 从 V4 会话和桌面 BrowserControl 入手，DeepSeek 从桌面 Host 连接层、子代理选模与浏览器 provider 入手。[桌面调研与上游接口](desktop-harness-model-capabilities-research.md) |
| `workspace.ts` | 需求确认记录、角色绑定、宿主事件、工具与浏览器观察 | 定位 `main` 的规范和契约，调用已有 Supervisor 和 Validator，处理允许、拒绝和续行动作。使用对应角色可读的证据路径。 |
| `workflow.ts`、`store.ts` | 用户控制、Planner 派单或裁决、执行回执 | 驱动确认、执行、复核与交接，保存发送记录、检查点和待决事项。可复用项目中持久任务、SQLite 与取消机制，封装实验性 API；一个 Workspace 同时只有一个有写权限的调度进程。[pi-durable](../packages/durable/README.md) |
| 桌面交互与 Pi 扩展 | 项目选择、配置、需求输入、任务状态、人工控制 | 在桌面工作流中呈现模型选择、确认、状态、补充、暂停、接管与验收。优先使用桌面宿主已公开的交互入口，必要时由扩展提供本地控制面。后台的 OCX CLI 只负责管理查询。Pi 扩展可以复用命令与生命周期事件，外部桌面工具的拦截必须落在宿主或其受控工具边界。[扩展入口](../packages/coding-agent/docs/extensions.md) |

宿主接口按行为实现，至少涵盖连接并识别桌面、按角色与路由打开会话、按会话投递并回读、订阅工具和回合事件、操作可见标签页、暂停与释放控制。用同一组契约测试驱动两个适配器。对每个宿主分别记录真实可用的工具、MCP 权限、图像输入、会话中断及控制权归还。验收需要 Figma 而会话缺少权限时，可用用户提供的设计材料；若材料仍不足，把具体比对项留给用户。

## 五、调度、机械拦截和恢复

| 转换 | 触发条件 | 运行时动作 |
|---|---|---|
| 草案 → 已确认 | 用户确认当前需求修订 | 保存目标、范围、验收项和执行委派授权。旧修订的确认不能启动新范围。 |
| 已确认 → 执行中 | Planner 派单，选定的宿主、角色、模型和必要能力均可用 | 保存派单意图，再向指定会话发送。回读确认后登记执行尝试。 |
| 执行中 → 待复核 | 宿主报告回合结束，已有治理实现接受回执 | 保存工具结果、浏览器证据位置和执行终态，通知 Planner。拒绝提前终止时，只向原会话投递 Supervisor 批准的继续动作。 |
| 待复核 → 执行中 / 待用户 / 验收通过 | Planner 对具体断言给出结论 | 分别登记待修项、真正依赖人的决定或通过依据，继续可独立完成的工作。 |
| 验收通过 → 同步 / 交付结束 | 对应等级所需同步和本需求剩余交付动作 | L/XL 由 Planner 下发唯一状态清单，Executor 更新，Planner 复核。还有发布或同步动作时继续显示真实下一步。 |
| 任一活动阶段 → 暂停、接管、取消或恢复 | 用户控制、会话断线、浏览器不可用 | 先封住新动作，报告在途操作。接管时释放本任务的写入与浏览器控制，恢复时重读当前页面、工作树与有效授权。保留用户已有窗口、标签页和服务。 |

调度记录保存在 Workspace 本机数据目录（建议 `.workflow/runtime/`，忽略提交）。每份派单关联需求修订、稳定验收项、父单、角色、公开路由、宿主会话、执行尝试、回执与裁决。原始证据按任务保存，给 Planner 暴露允许的行为结果。项目事实仍由 Workspace 的 `product/`、`knowledge/`、`memory/` 等目录承载。

宿主事件沿用 `agent-coding-engine.supervisor-event.v1`。重复事件用既有身份和修订去重。续行须符合 `send_required`、决定类型及精确发送目标，投递后回读。断线时若不清楚上一次写入或发送是否成功，先查宿主历史和实际结果；无法确定时显示待核实，防止重复改动、提交或发布。非即时任务登记输入、输出、进度、截止条件、取消方式、退出状态和清理结果。

**事前拦截须有可复现的拒绝案例。** Planner 的文件视图限制在角色允许范围内；Executor 的写入、Shell、MCP 与子进程操作受任务范围约束。未授权的发布必须在外部状态变化前被拒绝。仅有 Stop 事件的宿主还需要受控工具入口或进程隔离来覆盖相应动作。未经验证的能力在界面列为不可自动执行；治理观察来自实际工具结果。[既有终态与生命周期边界](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/.codex/governance/host-adapter-contract.md)

## 六、开发顺序与阶段出口

下表按依赖顺序执行。2026-11-11 本机已查到 ZCode Desktop `3.17.2`、DeepSeek Harness Desktop `0.2.2-rc.1`、OCX `2.100.1`。这些是安装信息；两个宿主的真实角色派单、子会话选模和可见浏览器控制都要分别验证。

| 阶段 | 交付内容 | 进入下一阶段的依据 |
|---|---|---|
| P0 · 桌面与治理可行性 | 从 Workspace `main` 准备隔离演练目录和一页有筛选、翻页的测试页面。分别确认已安装宿主如何定位精确会话、绑定执行模型、向可见标签页发送操作、读回结果并释放控制。核对实际宿主 ID、`init` 状态、角色绑定、工具前置拦截和 Supervisor 调用。 | 按宿主记录平台、版本、调用入口、实测结果、缺口和下一项。至少一个宿主能演示从执行会话点到第二页并读回内容，即可开展该宿主实现；另一个保留独立验收项。 |
| P1 · 最小纵向流程 | 实现配置与 OCX 目录、首个宿主适配、桌面确认入口、Planner 派单、Executor 回执、Supervisor 核验及 Planner 复核。先只开放 P0 已验证能事前约束的动作，串行完成一个需求。 | 在正常桌面入口，确认前无执行，确认后能指定子代理组合、完成真实页面操作并返回验收结果。 |
| P2 · 退回与人工控制 | 加入按项退回、稳定验收项、授权与角色门禁、持久记录、暂停、接管、取消、断线恢复和终态同步。 | 经历一次真实退回和修复，已通过项保留；拒绝越权操作；在途暂停、重复事件和重启均不重复产生工程副作用。 |
| P3 · 第二宿主与交付 | 用相同接口完成另一桌面宿主，接入能力检查和初始化指引。用实际包或扩展加载路径演练从安装、配置到验收，补齐用户使用说明。 | 两款宿主分别通过下表核心场景，列明可用平台和版本。用户从新 Workspace 只选其中一款，即可完成同一需求。 |

**DeepSeek 的具体起点。** 本次核对的 `main` 初始化清单已有 `zcode`，尚无 `deepseek-harness` 独立条目。P0 在隔离实例做管理员适配，登记该宿主并验证真实启动、角色绑定、工具允许与拒绝、事件投递和中断，再按 `init/README.md` 更新本机初始化结果。`custom` 条目可作开发参考，不能代替 DeepSeek 桌面端的验证。[main 的宿主清单](https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace/blob/19c941253291c3865535ddcd9f6806f69db9d3db/init/harness-list.json)

## 七、验收矩阵

| 场景 | 必须观察到的结果 |
|---|---|
| 确认与身份 | 未确认需求时没有 Executor。确认后子会话可追溯到用户授权。Planner 读源码、Executor 改治理文件和未授权外部操作均在动作前被拒绝。 |
| 分级与验收 | 小改动保留轻量回执。L/XL 有独立方向、执行回执、规划裁决和终态同步。明确缺陷反复出现仍按原项修复，无固定轮数自动通过或停止。 |
| 模型与组合 | OCX 未安装、未启动或不健康时，Pi 在创建 Harness 会话前拒绝派单。ZCode 展示完整 OCX 目录、启用状态和已保存组合，按配置切换其自身模型 provider；分别验证三种角色默认值及派单覆盖。DeepSeek Harness 只接受自身 DeepSeek provider。用受控上游使 ZCode 首选目标返回 429 或 5xx，验证真实 OCX 切到备选、仅产生一张派单；全部不可用时保留真实失败。 |
| 可见浏览器 | Executor 在用户能看到的目标标签页选择筛选条件并翻页，读回页码、筛选值、列表结果及截图。浏览器断开、只能无头运行或只有静态截图时保留待验收；重连后核对目标与实际状态。 |
| 确认的修订与人工介入 | 修改需求后旧裁决不能推进新范围。用户可在长操作中暂停、接管、恢复、取消，也能就特定验收项通过或退回。注销的是本次任务资源。 |
| 故障与交付 | 模拟发送后回执丢失、重复完成事件、重启、身份不符和有子任务在途。无重复派单、误投或提前结束；功能通过后仍能看到该需求剩余的合并、版本待确认和发布同步项。 |

测试分两层。调度与异常路径用临时仓库、假宿主和可控上游，具体缺陷用定向用例复现。两个桌面端各自保留一次可见操作和回执；模拟通过只说明调度逻辑通过。代码变更后按本仓库 [AGENTS.md](../AGENTS.md) 运行 `npm run check` 与相关定向测试，新增或修改的测试必须运行。验证以实际行为和结果回读为准。

## 八、新会话开工

从本仓库打开此文档及配置示例。本机的 Workspace 仓库在 `/usr/local/projects/Smart-WorkFlow`，当前工作树不一定检出 `main`。例如用 `git -C /usr/local/projects/Smart-WorkFlow show origin/main:system.md` 读取通用规则。用独立临时目录准备演练实例，已有业务工作树可继续使用原分支。

可以把下面这段直接发给新会话：

> 在 `/usr/local/projects/Smart-WorkFlow-Agent` 根据 `docs/local-harness-collaboration-plan.md` 开始开发，治理以 `Smart-WorkFlow-Agent-Workspace` 的 `main` 为准。先做 P0，分别记录 ZCode 与 DeepSeek Harness 桌面版的实测能力，用可见浏览器完成「筛选后翻页」。随后从可用宿主打通 P1，再按 P2、P3 完成退回、人工接管、恢复和另一宿主。每步按方案验收，报告已运行的结果和剩余项。
