import { join } from "node:path";
import {
	DeepSeekDesktopAdapter,
	DeepSeekDesktopHostClient,
	DeepSeekProtocolDriver,
	OcxReadinessGate,
	PersistentWorkflowRuntime,
	PythonSupervisorEventRunner,
	WorkflowRuntimeStore,
	WorkspaceSupervisor,
	assertProjectWorkspaceReady,
	projectWorkspacePath,
	readWorkflowConfig,
	resolveDeepSeekInstallation,
	resolveDeepSeekWorkflowRoutes,
} from "@earendil-works/pi-workflow-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptForAdditionalWorkflowAttempts } from "./workflow-continuation.ts";

async function runP3(ctx: ExtensionContext, executorName?: string): Promise<void> {
	const projectWorkspaceRoot = projectWorkspacePath(ctx.cwd);
	await assertProjectWorkspaceReady(projectWorkspaceRoot);
	const configPath = process.env.SMART_WORKFLOW_CONFIG ?? join(ctx.cwd, "workflow.config.yaml");
	const configResult = await readWorkflowConfig(configPath);
	if (!configResult.ok) {
		throw new Error(configResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
	}
	if (configResult.value.harness !== "deepseek-harness") {
		throw new Error(`当前配置选择了 ${configResult.value.harness}，不能启动 DeepSeek Harness 工作流`);
	}
	const routeResult = resolveDeepSeekWorkflowRoutes(configResult.value);
	if (!routeResult.ok) {
		throw new Error(routeResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
	}
	const route = executorName ? routeResult.routes.executors[executorName] : routeResult.routes.roles.executor;
	if (!route?.provider || !route.modelId) throw new Error(`未配置 DeepSeek Executor：${executorName ?? "默认"}`);
	const selectedModel = { provider: route.provider, model: route.modelId, reasoningEffort: "high" };
	const readiness = new OcxReadinessGate();
	await readiness.assertReady();
	const installation = await resolveDeepSeekInstallation();
	const stateDir = process.env.SMART_WORKFLOW_SUPERVISOR_STATE_DIR ?? `${ctx.cwd}/.workflow/supervisor`;
	const client = new DeepSeekDesktopHostClient({
		executable: installation.executable,
		entry: installation.entry,
		installationRoot: installation.installationRoot,
		profileDirectory: installation.profileDirectory,
		primaryRuntime: installation.primaryRuntime,
		packageManager: installation.packageManager,
		runtimeBin: installation.runtimeBin,
	});
	const adapter = new DeepSeekDesktopAdapter({
		workspacePath: ctx.cwd,
		driver: new DeepSeekProtocolDriver(client),
		resolveModelBinding: async (selectedRoute) => {
			if (selectedRoute.provider !== "deepseek-official" || !selectedRoute.modelId) {
				throw new Error(`DeepSeek Harness 不接受模型 ${selectedRoute.selector}`);
			}
			return { provider: selectedRoute.provider, model: selectedRoute.modelId, reasoningEffort: "high" };
		},
		requiredToolPrefix: "mcp__chrome-devtools-mcp__",
		timeoutMs: 240_000,
	});
	const supervisor = new WorkspaceSupervisor({
		runner: new PythonSupervisorEventRunner({
			root: projectWorkspaceRoot,
			stateDir,
			workspace: ctx.cwd,
			host: "deepseek-harness",
		}),
		workspace: ctx.cwd,
		host: "deepseek-harness",
	});
	const runtime = await PersistentWorkflowRuntime.open({
		id: "filter-pagination-deepseek",
		workspace: ctx.cwd,
		store: new WorkflowRuntimeStore(
			process.env.SMART_WORKFLOW_RUNTIME_STATE_DIR ?? join(ctx.cwd, ".workflow", "runtime"),
		),
		routes: routeResult.routes,
		adapter,
		supervisor,
		readiness,
	});

	ctx.ui.setStatus("workflow-p3-deepseek", "DeepSeek Harness 正在执行 P3");
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
					"只使用名称以 mcp__chrome-devtools-mcp__ 开头的工具操作插件启动的用户可见 Chromium。",
					"打开 http://127.0.0.1:4173/p0-filter-pagination-demo.html。",
					"把“部门”筛选为“财务部”，再点击“下一页”。",
					"读取当前部门、页码和表格内全部编号。",
					"禁止调用 Bash、Web Fetch、Web Search 或自行编写 CDP 脚本。",
					'结果写成单行 JSON：{"department":"财务部","page":"2 / 2","ids":["AP-110","AP-113","AP-116"]}',
				].join("\n"),
				plannerInstructions:
					"只使用名称以 mcp__chrome-devtools-mcp__ 开头的工具读取当前页面，不得用 Bash、Web Fetch 或自建 CDP 脚本代替验收。",
				maxAttempts: 60,
			},
			{ onLimitReached: (checkpoint) => promptForAdditionalWorkflowAttempts(ctx, checkpoint) },
		);
		if (result.status === "cancelled") {
			ctx.ui.notify(`任务已终止，累计派单 ${result.totalAttempts} 次`, "warning");
			return;
		}
		ctx.ui.notify(
			`P3 已通过：${result.attempt.receipt.output}\nPlanner：${result.review.reason}\n模型：${selectedModel.provider}/${selectedModel.model}`,
			"info",
		);
	} finally {
		await runtime.close();
		await client.close();
		ctx.ui.setStatus("workflow-p3-deepseek", undefined);
	}
}

export default function deepSeekProtocolWorkflow(pi: ExtensionAPI) {
	pi.registerCommand("workflow-p3-deepseek", {
		description: "通过 DeepSeek Desktop Host 与可见 Chromium 验收筛选后翻页",
		handler: async (args, ctx) => {
			try {
				await runP3(ctx, args.trim() || undefined);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
