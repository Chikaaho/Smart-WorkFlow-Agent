import { homedir } from "node:os";
import { join } from "node:path";
import {
	ChromeCdpBrowser,
	OcxReadinessGate,
	PythonSupervisorEventRunner,
	WorkflowCoordinator,
	WorkspaceSupervisor,
	ZCodeDesktopAdapter,
	ZCodeProtocolClient,
	ZCodeProtocolDriver,
	readOcxCatalog,
	readWorkflowConfig,
	readZCodeModelBinding,
	resolveWorkflowRoutes,
} from "@earendil-works/pi-workflow-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ZCODE_EXECUTABLE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const ZCODE_BUILTIN_PROVIDER_CONFIG =
	"/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json";
const ZCODE_PERSONAL_PROVIDER_CONFIG = join(homedir(), ".zcode", "v2", "provider_config.json");

async function runP1(
	ctx: ExtensionContext,
	executorName?: string,
): Promise<void> {
	const governanceRoot = process.env.SMART_WORKFLOW_GOVERNANCE_ROOT;
	if (!governanceRoot) {
		throw new Error("请先设置 SMART_WORKFLOW_GOVERNANCE_ROOT，指向 Workspace main 的治理副本");
	}
	const configPath = process.env.SMART_WORKFLOW_CONFIG ?? join(ctx.cwd, "workflow.config.yaml");
	const configResult = await readWorkflowConfig(configPath);
	if (!configResult.ok) {
		throw new Error(configResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
	}
	if (configResult.value.harness !== "zcode") {
		throw new Error(`当前配置选择了 ${configResult.value.harness}，不能启动 ZCode 工作流`);
	}
	const readiness = new OcxReadinessGate();
	await readiness.assertReady();
	const routeResult = resolveWorkflowRoutes(configResult.value, await readOcxCatalog());
	if (!routeResult.ok) {
		throw new Error(routeResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
	}
	const route = executorName ? routeResult.routes.executors[executorName] : routeResult.routes.roles.executor;
	if (!route) throw new Error(`未配置具名 Executor：${executorName}`);
	const binding = await readZCodeModelBinding(ZCODE_PERSONAL_PROVIDER_CONFIG, route);
	const stateDir = process.env.SMART_WORKFLOW_SUPERVISOR_STATE_DIR ?? `${ctx.cwd}/.workflow/supervisor`;
	const browser = new ChromeCdpBrowser();
	const client = new ZCodeProtocolClient({
		executable: ZCODE_EXECUTABLE,
		builtinProviderConfig: ZCODE_BUILTIN_PROVIDER_CONFIG,
		personalProviderConfig: ZCODE_PERSONAL_PROVIDER_CONFIG,
		workspacePath: ctx.cwd,
		browser,
		toolAllowlist: ["Skill", "mcp__node_repl__js"],
	});
	const adapter = new ZCodeDesktopAdapter({
		workspacePath: ctx.cwd,
		driver: new ZCodeProtocolDriver(client),
		resolveModelBinding: async (selectedRoute) =>
			await readZCodeModelBinding(ZCODE_PERSONAL_PROVIDER_CONFIG, selectedRoute),
		timeoutMs: 180_000,
	});
	const supervisor = new WorkspaceSupervisor({
		runner: new PythonSupervisorEventRunner({
			root: governanceRoot,
			stateDir,
			workspace: ctx.cwd,
			host: "zcode",
		}),
		workspace: ctx.cwd,
		host: "zcode",
	});
	const workflow = new WorkflowCoordinator(
		routeResult.routes,
		adapter,
		supervisor,
		readiness,
	);

	ctx.ui.setStatus("workflow-p1-zcode", `ZCode ${binding.providerName} 正在执行 P1`);
	try {
		const requirement = workflow.draft({
			id: `filter-pagination-${Date.now()}`,
			goal: "筛选后翻页",
			acceptance: ["部门仍为财务部", "页码为 2 / 2", "编号为 AP-110、AP-113、AP-116"],
		});
		workflow.confirm(requirement.revision);
		const attempt = await workflow.dispatch({
			...(executorName ? { executorName } : {}),
			prompt: [
				"只使用 Browser Use 操作用户可见的浏览器。",
				"打开 http://127.0.0.1:4173/p0-filter-pagination-demo.html。",
				"把“部门”筛选为“财务部”，再点击“下一页”。",
				"读取当前部门、页码和表格内全部编号。",
				"不得使用 Shell、curl、fetch、读取页面源码或其他浏览器。",
				'结果写成单行 JSON：{"department":"财务部","page":"2 / 2","ids":["AP-110","AP-113","AP-116"]}',
			].join("\n"),
		});
		if (!attempt.supervisor.accepted) {
			throw new Error(`Supervisor 未接受回执：${attempt.supervisor.reason}`);
		}
		workflow.review(attempt.taskId, true);
		ctx.ui.notify(
			`P1 已通过：${attempt.receipt.output}\n模型：${binding.providerName}/${binding.modelId}`,
			"info",
		);
	} finally {
		await client.close();
		ctx.ui.setStatus("workflow-p1-zcode", undefined);
	}
}

export default function zcodeProtocolWorkflow(pi: ExtensionAPI) {
	pi.registerCommand("workflow-p1-zcode", {
		description: "通过 ZCode 协议与可见 Chrome 验收筛选后翻页",
		handler: async (args, ctx) => {
			const executorName = args.trim() || undefined;
			try {
				await runP1(ctx, executorName);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
