import { join } from "node:path";
import {
	ChromeCdpBrowser,
	OcxReadinessGate,
	PersistentWorkflowRuntime,
	PythonSupervisorEventRunner,
	WorkflowRuntimeStore,
	WorkspaceSupervisor,
	ZCodeDesktopAdapter,
	ZCodeProtocolClient,
	ZCodeProtocolDriver,
	assertProjectWorkspaceReady,
	projectWorkspacePath,
	readOcxCatalog,
	readWorkflowConfig,
	readZCodeModelBinding,
	resolveZCodeInstallation,
	resolveWorkflowRoutes,
} from "@earendil-works/pi-workflow-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptForAdditionalWorkflowAttempts } from "./workflow-continuation.ts";

async function runP1(
	ctx: ExtensionContext,
	executorName?: string,
): Promise<void> {
	const projectWorkspaceRoot = projectWorkspacePath(ctx.cwd);
	await assertProjectWorkspaceReady(projectWorkspaceRoot);
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
	const installation = await resolveZCodeInstallation();
	const binding = await readZCodeModelBinding(installation.personalProviderConfig, route);
	const stateDir = process.env.SMART_WORKFLOW_SUPERVISOR_STATE_DIR ?? `${ctx.cwd}/.workflow/supervisor`;
	const browser = new ChromeCdpBrowser();
	const client = new ZCodeProtocolClient({
		executable: installation.agentExecutable,
		builtinProviderConfig: installation.builtinProviderConfig,
		personalProviderConfig: installation.personalProviderConfig,
		workspacePath: ctx.cwd,
		browser,
		toolAllowlist: ["Skill", "mcp__node_repl__js"],
	});
	const adapter = new ZCodeDesktopAdapter({
		workspacePath: ctx.cwd,
		driver: new ZCodeProtocolDriver(client),
		resolveModelBinding: async (selectedRoute) =>
			await readZCodeModelBinding(installation.personalProviderConfig, selectedRoute),
		requireBrowserEvidence: true,
		timeoutMs: 180_000,
	});
	const supervisor = new WorkspaceSupervisor({
		runner: new PythonSupervisorEventRunner({
			root: projectWorkspaceRoot,
			stateDir,
			workspace: ctx.cwd,
			host: "zcode",
		}),
		workspace: ctx.cwd,
		host: "zcode",
	});
	const runtime = await PersistentWorkflowRuntime.open({
		id: "filter-pagination-zcode",
		workspace: ctx.cwd,
		store: new WorkflowRuntimeStore(
			process.env.SMART_WORKFLOW_RUNTIME_STATE_DIR ?? join(ctx.cwd, ".workflow", "runtime"),
		),
		routes: routeResult.routes,
		adapter,
		supervisor,
		readiness,
	});

	ctx.ui.setStatus("workflow-p1-zcode", `ZCode ${binding.providerName} 正在执行 P1`);
	try {
		const result = await runtime.runUntilAccepted(
			{
				requirement: {
					id: "filter-pagination",
					goal: "筛选后翻页",
					acceptance: ["部门仍为财务部", "页码为 2 / 2", "编号为 AP-110、AP-113、AP-116"],
				},
				...(executorName ? { executorName } : {}),
				prompt: [
					"只使用 Browser Use 操作用户可见的浏览器。",
					"打开 http://127.0.0.1:4173/p0-filter-pagination-demo.html。",
					"把“部门”筛选为“财务部”，再点击“下一页”。",
					"读取当前部门、页码和表格内全部编号。",
					"不得使用 Shell、curl、fetch、读取页面源码或其他浏览器。",
					'结果写成单行 JSON：{"department":"财务部","page":"2 / 2","ids":["AP-110","AP-113","AP-116"]}',
				].join("\n"),
				plannerInstructions: "只使用 Browser Use 读取当前可见页面，不得用 Shell、fetch 或页面源码代替验收。",
				maxAttempts: 60,
			},
			{ onLimitReached: (checkpoint) => promptForAdditionalWorkflowAttempts(ctx, checkpoint) },
		);
		if (result.status === "cancelled") {
			ctx.ui.notify(`任务已终止，累计派单 ${result.totalAttempts} 次`, "warning");
			return;
		}
		ctx.ui.notify(
			`P1 已通过：${result.attempt.receipt.output}\nPlanner：${result.review.reason}\n模型：${binding.providerName}/${binding.modelId}`,
			"info",
		);
	} finally {
		await runtime.close();
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
