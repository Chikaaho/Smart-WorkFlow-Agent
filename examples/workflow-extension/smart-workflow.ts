import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ChromeCdpBrowser,
	DeepSeekDesktopAdapter,
	DeepSeekDesktopHostClient,
	DeepSeekProtocolDriver,
	OcxReadinessGate,
	PersistentWorkflowRuntime,
	PythonSupervisorEventRunner,
	WorkflowRuntimeStore,
	WorkspaceSupervisor,
	ZCodeDesktopAdapter,
	ZCodeProtocolClient,
	ZCodeProtocolDriver,
	assertOcxReady,
	planWorkflowTask,
	readOcxCatalog,
	readWorkflowConfig,
	readZCodeModelBinding,
	resolveChromeExecutable,
	resolveDeepSeekInstallation,
	resolveDeepSeekWorkflowRoutes,
	resolveWorkflowRoutes,
	resolveZCodeInstallation,
	type DeepSeekInstallationPaths,
	type DesktopHarnessAdapter,
	type ResolvedWorkflowRoutes,
	type WorkflowConfig,
	type WorkflowProgressEvent,
	type WorkflowReadinessGate,
	type WorkflowSupervisor,
	type WorkflowTaskPlan,
	type ZCodeInstallationPaths,
} from "@earendil-works/pi-workflow-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptForAdditionalWorkflowAttempts } from "./workflow-continuation.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));

interface SetupInspection {
	ready: boolean;
	summary: string;
	configPath: string;
	config?: WorkflowConfig;
	routes?: ResolvedWorkflowRoutes;
	governanceRoot?: string;
	zcodeInstallation?: ZCodeInstallationPaths;
	deepSeekInstallation?: DeepSeekInstallationPaths;
}

interface OpenHarness {
	adapter: DesktopHarnessAdapter;
	routes: ResolvedWorkflowRoutes;
	readiness: WorkflowReadinessGate;
	supervisor: WorkflowSupervisor;
	label: string;
	close(): Promise<void>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function harnessTimeoutMs(): number {
	const configured = process.env.SMART_WORKFLOW_HARNESS_TIMEOUT_MS?.trim();
	if (!configured) return 900_000;
	const timeoutMs = Number(configured);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
		throw new Error("SMART_WORKFLOW_HARNESS_TIMEOUT_MS 必须是大于或等于 60000 的整数毫秒值");
	}
	return timeoutMs;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function inspectSetup(ctx: ExtensionContext): Promise<SetupInspection> {
	const configPath = process.env.SMART_WORKFLOW_CONFIG ?? join(ctx.cwd, "workflow.config.yaml");
	const governanceRoot = process.env.SMART_WORKFLOW_GOVERNANCE_ROOT?.trim();
	const lines: string[] = [];
	let ready = true;
	let config: WorkflowConfig | undefined;
	let routes: ResolvedWorkflowRoutes | undefined;
	let zcodeInstallation: ZCodeInstallationPaths | undefined;
	let deepSeekInstallation: DeepSeekInstallationPaths | undefined;

	try {
		const result = await readWorkflowConfig(configPath);
		if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
		config = result.value;
		lines.push(`配置：${config.harness} · ${configPath}`);
	} catch (error) {
		ready = false;
		lines.push(`配置：未就绪 · ${message(error)}`);
		lines.push(
			`复制 ${join(extensionDirectory, "workflow.config.example.yaml")} 或 workflow.deepseek.config.example.yaml 到 ${configPath}`,
		);
	}

	let catalog: Awaited<ReturnType<typeof readOcxCatalog>> | undefined;
	try {
		const status = await assertOcxReady();
		catalog = await readOcxCatalog();
		if (catalog.models.length === 0) throw new Error("OCX 没有可用模型，请先运行 ocx setup 并配置模型账号");
		lines.push(
			`OCX：运行中${status.version ? ` ${status.version}` : ""} · ${catalog.models.length} 个模型 · ${catalog.combos.length} 个组合`,
		);
	} catch (error) {
		ready = false;
		lines.push(`OCX：未就绪 · ${message(error)}`);
		lines.push("安装和配置：npm install -g @bitkyc08/opencodex@2.100.1 && ocx setup && ocx start");
	}

	const [chromeResult, zcodeResult, deepSeekResult] = await Promise.allSettled([
		resolveChromeExecutable(),
		resolveZCodeInstallation(),
		resolveDeepSeekInstallation(),
	]);
	if (chromeResult.status === "fulfilled") lines.push(`Chrome：${chromeResult.value}`);
	else {
		ready = false;
		lines.push(`Chrome：未就绪 · ${message(chromeResult.reason)}`);
	}
	if (zcodeResult.status === "fulfilled") {
		zcodeInstallation = zcodeResult.value;
		lines.push(`ZCode：已安装并找到模型配置 · ${zcodeInstallation.resourcesDirectory}`);
	} else {
		lines.push(`ZCode：未就绪 · ${message(zcodeResult.reason)}`);
		if (config?.harness === "zcode") ready = false;
	}
	if (deepSeekResult.status === "fulfilled") {
		deepSeekInstallation = deepSeekResult.value;
		lines.push(`DeepSeek Harness：已安装 · ${deepSeekInstallation.applicationDirectory}`);
		try {
			const profile = await readFile(join(deepSeekInstallation.profileDirectory, "cordis.patch.yml"), "utf8");
			if (
				!profile.includes("@deepseek-ai/dsh-browser-use") ||
				!profile.includes("@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp")
			) {
				throw new Error("Desktop profile 没有挂载两个 Browser Use 插件");
			}
			lines.push("DeepSeek Browser Use：已配置；请确保桌面端已登录 DeepSeek 账号");
		} catch (error) {
			lines.push(`DeepSeek Browser Use：未就绪 · ${message(error)}`);
			if (config?.harness === "deepseek-harness") ready = false;
		}
	} else {
		lines.push(`DeepSeek Harness：未就绪 · ${message(deepSeekResult.reason)}`);
		if (config?.harness === "deepseek-harness") ready = false;
	}

	if (!governanceRoot) {
		ready = false;
		lines.push("治理：未设置 SMART_WORKFLOW_GOVERNANCE_ROOT");
	} else if (!(await pathExists(join(governanceRoot, ".codex", "governance", "execution-supervisor.py")))) {
		ready = false;
		lines.push(`治理：${governanceRoot} 不是可用的 Workspace main 工作树`);
	} else {
		lines.push(`治理：${governanceRoot}`);
	}

	if (config) {
		if (config.harness === "zcode" && catalog && zcodeInstallation) {
			const routeResult = resolveWorkflowRoutes(config, catalog);
			if (!routeResult.ok) {
				ready = false;
				lines.push(`角色模型：${routeResult.issues.map((issue) => issue.message).join("；")}`);
			} else {
				try {
					await Promise.all(
						[...Object.values(routeResult.routes.roles), ...Object.values(routeResult.routes.executors)].map(
							async (route) => await readZCodeModelBinding(zcodeInstallation.personalProviderConfig, route),
						),
					);
					routes = routeResult.routes;
					lines.push(
						`角色模型：Planner=${routes.roles.planner.selector} · Executor=${routes.roles.executor.selector} · Admin=${routes.roles.admin.selector}`,
					);
				} catch (error) {
					ready = false;
					lines.push(`ZCode 账号或模型：未就绪 · ${message(error)}`);
				}
			}
		}
		if (config.harness === "deepseek-harness" && deepSeekInstallation) {
			const routeResult = resolveDeepSeekWorkflowRoutes(config);
			if (!routeResult.ok) {
				ready = false;
				lines.push(`角色模型：${routeResult.issues.map((issue) => issue.message).join("；")}`);
			} else {
				routes = routeResult.routes;
				lines.push(
					`角色模型：Planner=${routes.roles.planner.selector} · Executor=${routes.roles.executor.selector} · Admin=${routes.roles.admin.selector}`,
				);
			}
		}
	}

	return {
		ready: ready && Boolean(config && routes && governanceRoot),
		summary: lines.join("\n"),
		configPath,
		...(config ? { config } : {}),
		...(routes ? { routes } : {}),
		...(governanceRoot ? { governanceRoot } : {}),
		...(zcodeInstallation ? { zcodeInstallation } : {}),
		...(deepSeekInstallation ? { deepSeekInstallation } : {}),
	};
}

async function openHarness(ctx: ExtensionContext, setup: SetupInspection): Promise<OpenHarness> {
	if (!setup.ready || !setup.config || !setup.routes || !setup.governanceRoot) {
		throw new Error(setup.summary);
	}
	const readiness = new OcxReadinessGate();
	const timeoutMs = harnessTimeoutMs();
	const stateDir = process.env.SMART_WORKFLOW_SUPERVISOR_STATE_DIR ?? join(ctx.cwd, ".workflow", "supervisor");
	const supervisor = new WorkspaceSupervisor({
		runner: new PythonSupervisorEventRunner({
			root: setup.governanceRoot,
			stateDir,
			workspace: ctx.cwd,
			host: setup.config.harness,
		}),
		workspace: ctx.cwd,
		host: setup.config.harness,
	});

	if (setup.config.harness === "zcode") {
		const installation = setup.zcodeInstallation;
		if (!installation) throw new Error("ZCode 尚未完成安装和模型配置");
		const client = new ZCodeProtocolClient({
			executable: installation.agentExecutable,
			builtinProviderConfig: installation.builtinProviderConfig,
			personalProviderConfig: installation.personalProviderConfig,
			workspacePath: ctx.cwd,
			browser: new ChromeCdpBrowser(),
		});
		return {
			adapter: new ZCodeDesktopAdapter({
				workspacePath: ctx.cwd,
				driver: new ZCodeProtocolDriver(client),
				resolveModelBinding: async (route) =>
					await readZCodeModelBinding(installation.personalProviderConfig, route),
				requireBrowserEvidence: true,
				timeoutMs,
			}),
			routes: setup.routes,
			readiness,
			supervisor,
			label: "ZCode",
			close: async () => await client.close(),
		};
	}

	const installation = setup.deepSeekInstallation;
	if (!installation) throw new Error("DeepSeek Harness 尚未完成安装和浏览器插件配置");
	const client = new DeepSeekDesktopHostClient({
		executable: installation.executable,
		entry: installation.entry,
		installationRoot: installation.installationRoot,
		profileDirectory: installation.profileDirectory,
		primaryRuntime: installation.primaryRuntime,
		packageManager: installation.packageManager,
		runtimeBin: installation.runtimeBin,
	});
	return {
		adapter: new DeepSeekDesktopAdapter({
			workspacePath: ctx.cwd,
			driver: new DeepSeekProtocolDriver(client),
			resolveModelBinding: async (route) => {
				if (route.provider !== "deepseek-official" || !route.modelId) {
					throw new Error(`DeepSeek Harness 不接受模型 ${route.selector}`);
				}
				return { provider: route.provider, model: route.modelId, reasoningEffort: "high" };
			},
			requiredToolPrefix: "mcp__chrome-devtools-mcp__",
			timeoutMs,
		}),
		routes: setup.routes,
		readiness,
		supervisor,
		label: "DeepSeek Harness",
		close: async () => await client.close(),
	};
}

function formatPlan(plan: WorkflowTaskPlan): string {
	return [
		`目标：${plan.goal}`,
		"",
		"验收条件：",
		...plan.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
		"",
		`Executor：${plan.executorName ?? "默认"}`,
		"",
		"派单：",
		plan.executorPrompt,
	].join("\n");
}

function progressReporter(ctx: ExtensionContext, label: string): (event: WorkflowProgressEvent) => void {
	return (event) => {
		if (event.type === "executor_dispatching") {
			ctx.ui.setStatus("smart-workflow", `${label} · Executor 第 ${event.attemptNumber} 次执行`);
			return;
		}
		if (event.type === "executor_completed") {
			ctx.ui.setStatus("smart-workflow", `${label} · Supervisor 已接收，等待 Planner 验收`);
			return;
		}
		if (event.type === "planner_reviewed") {
			ctx.ui.notify(
				`Planner：${event.review.accepted ? "通过" : "退回"} · ${event.review.reason}`,
				event.review.accepted ? "info" : "warning",
			);
			return;
		}
		if (event.type === "limit_reached") {
			ctx.ui.setStatus("smart-workflow", `${label} · 已达到本轮上限`);
			return;
		}
		ctx.ui.setStatus("smart-workflow", `${label} · ${event.type === "accepted" ? "验收通过" : "已终止"}`);
	};
}

async function collectPlan(
	ctx: ExtensionContext,
	harness: OpenHarness,
	taskId: string,
): Promise<WorkflowTaskPlan | undefined> {
	let request = await ctx.ui.editor("输入任务");
	while (request?.trim()) {
		ctx.ui.setStatus("smart-workflow", `${harness.label} · Planner 正在规划`);
		const plan = await planWorkflowTask({
			taskId,
			request: request.trim(),
			routes: harness.routes,
			adapter: harness.adapter,
			readiness: harness.readiness,
		});
		if (await ctx.ui.confirm("确认任务规划", formatPlan(plan))) return plan;
		request = await ctx.ui.editor("修改任务后重新规划", request);
	}
	return undefined;
}

async function runWorkflow(ctx: ExtensionContext, requestedExecutor?: string): Promise<void> {
	const setup = await inspectSetup(ctx);
	if (!setup.ready) throw new Error(setup.summary);
	const harness = await openHarness(ctx, setup);
	const store = new WorkflowRuntimeStore(
		process.env.SMART_WORKFLOW_RUNTIME_STATE_DIR ?? join(ctx.cwd, ".workflow", "runtime"),
	);
	let runtime: PersistentWorkflowRuntime | undefined;
	try {
		const active = await store.latestActive(ctx.cwd);
		let runtimeId: string;
		let goal: string;
		let acceptance: string[];
		let prompt: string;
		let executorName = requestedExecutor;

		if (active) {
			const requirement = active.runtime.snapshot.requirement;
			if (!requirement) throw new Error(`运行记录 ${active.id} 缺少需求`);
			const resume = await ctx.ui.confirm(
				"发现未完成任务",
				`目标：${requirement.goal}\n阶段：${active.runtime.snapshot.phase}\n是否恢复？`,
			);
			if (!resume) {
				const cancel = await ctx.ui.confirm("终止未完成任务", "终止旧任务后才能创建新任务，是否终止？");
				if (!cancel) return;
				const oldRuntime = await PersistentWorkflowRuntime.open({
					id: active.id,
					workspace: ctx.cwd,
					store,
					routes: harness.routes,
					adapter: harness.adapter,
					supervisor: harness.supervisor,
					readiness: harness.readiness,
				});
				await oldRuntime.cancel();
				await oldRuntime.close();
				runtimeId = randomUUID();
				const plan = await collectPlan(ctx, harness, runtimeId);
				if (!plan) return;
				goal = plan.goal;
				acceptance = plan.acceptance;
				prompt = plan.executorPrompt;
				executorName ??= plan.executorName;
			} else {
				runtimeId = active.id;
				goal = requirement.goal;
				acceptance = requirement.acceptance;
				prompt =
					active.runtime.snapshot.reviews.toReversed().find((review) => !review.accepted)?.nextPrompt ??
					`继续完成目标：${goal}\n验收条件：\n${acceptance.map((item) => `- ${item}`).join("\n")}`;
				executorName ??= active.runtime.snapshot.attempts.at(-1)?.executorName;
			}
		} else {
			runtimeId = randomUUID();
			const plan = await collectPlan(ctx, harness, runtimeId);
			if (!plan) return;
			goal = plan.goal;
			acceptance = plan.acceptance;
			prompt = plan.executorPrompt;
			executorName ??= plan.executorName;
		}

		if (executorName && !harness.routes.executors[executorName]) {
			throw new Error(`未配置具名 Executor：${executorName}`);
		}
		runtime = await PersistentWorkflowRuntime.open({
			id: runtimeId,
			workspace: ctx.cwd,
			store,
			routes: harness.routes,
			adapter: harness.adapter,
			supervisor: harness.supervisor,
			readiness: harness.readiness,
		});
		const result = await runtime.runUntilAccepted(
			{
				requirement: { id: runtimeId, goal, acceptance },
				prompt,
				...(executorName ? { executorName } : {}),
				plannerInstructions: [
					"独立核对实际工程结果和行为证据，不得只接受 Executor 自述。",
					"任务涉及页面时，必须使用当前 Harness 的浏览器工具读取用户可见页面。",
					"任务产生仓库变更时，核对提交、当前远端分支推送结果和工作树状态。",
				].join("\n"),
				maxAttempts: 60,
			},
			{
				onLimitReached: (checkpoint) => promptForAdditionalWorkflowAttempts(ctx, checkpoint),
				onProgress: progressReporter(ctx, harness.label),
			},
		);
		if (result.status === "cancelled") {
			ctx.ui.notify(`任务已终止，累计派单 ${result.totalAttempts} 次，终态已保存为 cancelled`, "warning");
			return;
		}
		ctx.ui.notify(
			[
				"任务已验收；后续状态、终态同步和 Git 收尾已通过 Planner 复核，运行记录已保存为 accepted。",
				`Planner：${result.review.reason}`,
				`累计派单：${result.snapshot.attempts.length}`,
				`Executor 回执：${result.attempt.receipt.output}`,
			].join("\n"),
			"info",
		);
	} finally {
		await runtime?.close();
		await harness.close();
		ctx.ui.setStatus("smart-workflow", undefined);
	}
}

export default function smartWorkflow(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const setup = await inspectSetup(ctx);
			ctx.ui.notify(setup.ready ? `Smart-WorkFlow 已就绪\n${setup.summary}` : setup.summary, setup.ready ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(message(error), "error");
		}
	});

	pi.registerCommand("workflow-setup", {
		description: "检查 OCX、桌面 Harness、角色模型和 Workspace 治理配置",
		handler: async (_args, ctx) => {
			try {
				const setup = await inspectSetup(ctx);
				ctx.ui.notify(setup.summary, setup.ready ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(message(error), "error");
			}
		},
	});

	pi.registerCommand("workflow", {
		description: "规划、执行、验收、提交并推送一个通用项目任务",
		handler: async (args, ctx) => {
			try {
				await runWorkflow(ctx, args.trim() || undefined);
			} catch (error) {
				ctx.ui.notify(message(error), "error");
				ctx.ui.setStatus("smart-workflow", undefined);
			}
		},
	});
}
