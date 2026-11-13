import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ChromeCdpBrowser,
	DeepSeekDesktopAdapter,
	DeepSeekDesktopHostClient,
	DeepSeekProtocolDriver,
	OCX_USER_CONFIG_FILENAME,
	OcxReadinessGate,
	PersistentWorkflowRuntime,
	PythonSupervisorEventRunner,
	WorkflowRuntimeStore,
	WorkspaceSupervisor,
	ZCodeDesktopAdapter,
	ZCodeProtocolClient,
	ZCodeProtocolDriver,
	assertProjectWorkspaceReady,
	createProjectWorkspaceDraft,
	ensureOcxUserConfig,
	isOcxAccountUsable,
	planWorkflowTask,
	projectWorkflowPaths,
	projectWorkspacePath,
	readWorkflowConfig,
	readZCodeModelBinding,
	resolveChromeExecutable,
	resolveDeepSeekInstallation,
	resolveDeepSeekWorkflowRoutes,
	resolveProjectDirectory,
	resolveWorkflowRoutes,
	resolveZCodeInstallation,
	type DeepSeekInstallationPaths,
	type DispatchInput,
	type DesktopHarnessAdapter,
	type OcxCatalog,
	type OcxUserIntegration,
	type PreparedDispatch,
	type ResolvedWorkflowRoutes,
	type WorkflowConfig,
	type WorkflowProgressEvent,
	type WorkflowReadinessGate,
	type WorkflowSupervisor,
	type WorkflowTaskPlan,
	type ZCodeInstallationPaths,
} from "@earendil-works/pi-workflow-agent";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptForAdditionalWorkflowAttempts } from "./workflow-continuation.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectoryEntry = "smart-workflow-project-directory";

interface ProjectDirectoryState {
	projectRoot: string;
}

interface SetupInspection {
	ready: boolean;
	summary: string;
	configPath: string;
	config?: WorkflowConfig;
	routes?: ResolvedWorkflowRoutes;
	projectWorkspaceRoot: string;
	ocx?: OcxUserIntegration;
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

async function inspectSetup(
	ctx: ExtensionContext,
	projectRoot: string,
	options: { projectWorkspaceRoot?: string; requireInitializedWorkspace?: boolean } = {},
): Promise<SetupInspection> {
	const configPath = projectWorkflowPaths(projectRoot).config;
	const projectWorkspaceRoot = options.projectWorkspaceRoot ?? projectWorkspacePath(projectRoot);
	const requireInitializedWorkspace = options.requireInitializedWorkspace ?? true;
	const lines: string[] = [`项目目录：${projectRoot}`];
	let ready = true;
	let config: WorkflowConfig | undefined;
	let routes: ResolvedWorkflowRoutes | undefined;
	let ocx: OcxUserIntegration | undefined;
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

	let catalog: OcxCatalog | undefined;
	try {
		const ocxConfigPath = join(getAgentDir(), OCX_USER_CONFIG_FILENAME);
		ocx = await ensureOcxUserConfig({ configPath: ocxConfigPath });
		catalog = ocx.catalog;
		lines.push(
			`OCX：运行中${ocx.status.version ? ` ${ocx.status.version}` : ""} · ${catalog.models.length} 个模型 · ${catalog.combos.length} 个组合`,
		);
		lines.push(`OCX 账号：${ocx.accounts.filter(isOcxAccountUsable).length} 个可用`);
		lines.push(`OCX 用户配置：${ocxConfigPath}${ocx.created ? " · 已创建" : ""}`);
	} catch (error) {
		ready = false;
		lines.push(`OCX：未就绪 · ${message(error)}`);
		lines.push("依次运行：npm install -g @bitkyc08/opencodex@2.100.1、ocx setup、ocx start，再执行 /ocx-setup");
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

	if (!(await pathExists(join(projectWorkspaceRoot, ".codex", "governance", "execution-supervisor.py")))) {
		ready = false;
		lines.push(`项目 Workspace：未初始化 · 运行 /init（目标目录：${projectWorkspaceRoot}）`);
	} else {
		let workspaceReady = true;
		if (requireInitializedWorkspace) {
			try {
				await assertProjectWorkspaceReady(projectWorkspaceRoot);
			} catch (error) {
				ready = false;
				workspaceReady = false;
				lines.push(`项目 Workspace：未完成 · ${message(error)}`);
			}
		}
		if (workspaceReady) lines.push(`项目 Workspace：${projectWorkspaceRoot}`);
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
		ready: ready && Boolean(config && routes),
		summary: lines.join("\n"),
		configPath,
		projectWorkspaceRoot,
		...(config ? { config } : {}),
		...(routes ? { routes } : {}),
		...(ocx ? { ocx } : {}),
		...(zcodeInstallation ? { zcodeInstallation } : {}),
		...(deepSeekInstallation ? { deepSeekInstallation } : {}),
	};
}

async function openHarness(
	ctx: ExtensionContext,
	projectRoot: string,
	setup: SetupInspection,
	options: { requireBrowserEvidence?: boolean } = {},
): Promise<OpenHarness> {
	if (!setup.ready || !setup.config || !setup.routes || !setup.ocx) {
		throw new Error(setup.summary);
	}
	const readiness = new OcxReadinessGate(setup.ocx.runner);
	const timeoutMs = harnessTimeoutMs();
	const requireBrowserEvidence = options.requireBrowserEvidence ?? true;
	const stateDir = projectWorkflowPaths(projectRoot).supervisor;
	const supervisor = new WorkspaceSupervisor({
		runner: new PythonSupervisorEventRunner({
			root: setup.projectWorkspaceRoot,
			stateDir,
			workspace: projectRoot,
			host: setup.config.harness,
		}),
		workspace: projectRoot,
		host: setup.config.harness,
	});

	if (setup.config.harness === "zcode") {
		const installation = setup.zcodeInstallation;
		if (!installation) throw new Error("ZCode 尚未完成安装和模型配置");
		const client = new ZCodeProtocolClient({
			executable: installation.agentExecutable,
			builtinProviderConfig: installation.builtinProviderConfig,
			personalProviderConfig: installation.personalProviderConfig,
			workspacePath: projectRoot,
			browser: new ChromeCdpBrowser(),
		});
		return {
			adapter: new ZCodeDesktopAdapter({
				workspacePath: projectRoot,
				driver: new ZCodeProtocolDriver(client),
				resolveModelBinding: async (route) =>
					await readZCodeModelBinding(installation.personalProviderConfig, route),
				requireBrowserEvidence,
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
			workspacePath: projectRoot,
			driver: new DeepSeekProtocolDriver(client),
			resolveModelBinding: async (route) => {
				if (route.provider !== "deepseek-official" || !route.modelId) {
					throw new Error(`DeepSeek Harness 不接受模型 ${route.selector}`);
				}
				return { provider: route.provider, model: route.modelId };
			},
			...(requireBrowserEvidence ? { requiredToolPrefix: "mcp__chrome-devtools-mcp__" } : {}),
			timeoutMs,
		}),
		routes: setup.routes,
		readiness,
		supervisor,
		label: "DeepSeek Harness",
		close: async () => await client.close(),
	};
}

function initializationPrompt(projectRoot: string, workspacePath: string): string {
	return [
		"初始化本项目的 Workspace knowledge。",
		`项目代码目录：${projectRoot}`,
		`待初始化 Workspace：${workspacePath}`,
		"",
		"先完整阅读以下文件：",
		`- ${join(workspacePath, "system.md")}`,
		`- ${join(workspacePath, "roles", "executor.md")}`,
		`- ${join(workspacePath, "project.example.md")}`,
		`- ${join(workspacePath, "knowledge", "README.md")}`,
		`- ${join(workspacePath, "knowledge", "project-materials.md")}`,
		"",
		"然后读取项目代码、README、现有文档和 Git 当前状态，完成：",
		`1. 按 project.example.md 的结构写 ${join(workspacePath, "project.md")}。`,
		`2. 按实际项目内容初始化 ${join(workspacePath, "knowledge")}，至少更新 current-status.md 和 architecture.md。`,
		`3. 同步更新 ${join(workspacePath, "memory")} 中对应的 Planner 摘要。`,
		"4. 保留 knowledge/project-materials.md 中的用户原始材料，不得改写或删除。",
		"5. 只记录能从用户材料、项目文件或 Git 状态中确认的事实；无法确认的内容明确标为待确认。",
		"6. 不修改项目代码，不提交，不推送。",
		"",
		"完成后说明更新了哪些 Workspace 文件，以及仍需用户确认的事项。",
	].join("\n");
}

async function initializeProject(ctx: ExtensionContext, projectRoot: string): Promise<void> {
	const finalPath = projectWorkspacePath(projectRoot);
	if (await pathExists(finalPath)) {
		try {
			await assertProjectWorkspaceReady(finalPath);
			ctx.ui.notify(`项目 Workspace 已初始化：${finalPath}`, "info");
			return;
		} catch (error) {
			throw new Error(`项目 Workspace 已存在但未完成，拒绝覆盖：${finalPath}\n${message(error)}`);
		}
	}
	const materials = await ctx.ui.editor("输入项目材料（可粘贴项目说明、文件或目录路径、文档链接）");
	if (!materials?.trim()) return;

	ctx.ui.setStatus("smart-workflow", "正在创建项目 Workspace");
	const draft = await createProjectWorkspaceDraft({
		projectRoot,
		materials,
		templateSource: process.env.SMART_WORKFLOW_TEMPLATE,
	});
	let harness: OpenHarness | undefined;
	let prepared: PreparedDispatch | undefined;
	let finalized = false;
	try {
		const setup = await inspectSetup(ctx, projectRoot, {
			projectWorkspaceRoot: draft.workspacePath,
			requireInitializedWorkspace: false,
		});
		if (!setup.ready) throw new Error(setup.summary);
		harness = await openHarness(ctx, projectRoot, setup, { requireBrowserEvidence: false });
		await harness.readiness.assertReady();
		const taskId = `init:${randomUUID()}`;
		const dispatch: DispatchInput = {
			taskId,
			role: "executor",
			stage: "execution",
			requirement: {
				id: taskId,
				revision: 1,
				goal: "根据用户材料和项目现状初始化项目 Workspace knowledge",
				acceptance: [
					"project.md 已按项目事实完成",
					"knowledge/current-status.md 与 knowledge/architecture.md 已完成项目化",
					"memory 中的 Planner 摘要已同步",
					"用户原始材料完整保留",
				],
			},
			model: harness.routes.roles.executor,
			prompt: initializationPrompt(projectRoot, draft.workspacePath),
		};
		ctx.ui.setStatus("smart-workflow", `${harness.label} · Executor 正在初始化 Workspace`);
		prepared = await harness.adapter.prepare(dispatch);
		const receipt = await harness.adapter.dispatch(dispatch, prepared);
		await assertProjectWorkspaceReady(draft.workspacePath);
		await draft.finalize();
		finalized = true;
		ctx.ui.notify(
			[`项目 Workspace 已初始化：${draft.finalPath}`, `Executor 回执：${receipt.output}`].join("\n"),
			"info",
		);
	} finally {
		const cleanup: Promise<void>[] = [];
		if (prepared && harness?.adapter.release) cleanup.push(harness.adapter.release(prepared));
		if (harness) cleanup.push(harness.close());
		await Promise.allSettled(cleanup);
		try {
			if (!finalized) await draft.discard();
		} finally {
			ctx.ui.setStatus("smart-workflow", undefined);
		}
	}
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

async function runWorkflow(ctx: ExtensionContext, projectRoot: string, requestedExecutor?: string): Promise<void> {
	const setup = await inspectSetup(ctx, projectRoot);
	if (!setup.ready) throw new Error(setup.summary);
	const harness = await openHarness(ctx, projectRoot, setup);
	const store = new WorkflowRuntimeStore(projectWorkflowPaths(projectRoot).runtime);
	let runtime: PersistentWorkflowRuntime | undefined;
	try {
		const active = await store.latestActive(projectRoot);
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
					workspace: projectRoot,
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
			workspace: projectRoot,
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
	let activeProjectRoot: string | undefined;

	function savedProjectRoot(ctx: ExtensionContext): string | undefined {
		let saved: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== projectDirectoryEntry) continue;
			const state = entry.data as ProjectDirectoryState | undefined;
			if (typeof state?.projectRoot === "string") saved = state.projectRoot;
		}
		return saved;
	}

	async function restoreProjectRoot(ctx: ExtensionContext): Promise<string> {
		const saved = savedProjectRoot(ctx);
		if (!saved) {
			activeProjectRoot = ctx.cwd;
			return activeProjectRoot;
		}
		try {
			activeProjectRoot = await resolveProjectDirectory(ctx.cwd, saved);
		} catch (error) {
			activeProjectRoot = ctx.cwd;
			if (ctx.hasUI) ctx.ui.notify(`已保存的项目目录不可用，恢复为启动目录\n${message(error)}`, "warning");
		}
		return activeProjectRoot;
	}

	async function selectProjectRoot(args: string, ctx: ExtensionContext): Promise<string | undefined> {
		const current = activeProjectRoot ?? ctx.cwd;
		const input = args.trim() || (await ctx.ui.editor("输入项目目录", current));
		if (!input?.trim()) return undefined;
		const projectRoot = await resolveProjectDirectory(current, input);
		activeProjectRoot = projectRoot;
		pi.appendEntry<ProjectDirectoryState>(projectDirectoryEntry, { projectRoot });
		ctx.ui.notify(`项目目录已切换：${projectRoot}`, "info");
		return projectRoot;
	}

	pi.on("session_start", async (_event, ctx) => {
		const projectRoot = await restoreProjectRoot(ctx);
		if (!ctx.hasUI) return;
		try {
			const setup = await inspectSetup(ctx, projectRoot);
			ctx.ui.notify(setup.ready ? `Smart-WorkFlow 已就绪\n${setup.summary}` : setup.summary, setup.ready ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(message(error), "error");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreProjectRoot(ctx);
	});

	pi.registerCommand("project-dir", {
		description: "查看或切换当前项目执行目录",
		handler: async (args, ctx) => {
			try {
				await selectProjectRoot(args, ctx);
			} catch (error) {
				ctx.ui.notify(message(error), "error");
			}
		},
	});

	pi.registerCommand("workflow-setup", {
		description: "检查 OCX、桌面 Harness、角色模型和项目 Workspace",
		handler: async (_args, ctx) => {
			try {
				const setup = await inspectSetup(ctx, activeProjectRoot ?? ctx.cwd);
				ctx.ui.notify(setup.summary, setup.ready ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(message(error), "error");
			}
		},
	});

	pi.registerCommand("ocx-setup", {
		description: "检查 OCX 并创建用户全局配置，可选参数为 OCX CLI 路径",
		handler: async (args, ctx) => {
			const configPath = join(getAgentDir(), OCX_USER_CONFIG_FILENAME);
			try {
				const executable = args.trim() || undefined;
				const ocx = await ensureOcxUserConfig({ configPath, ...(executable ? { executable } : {}) });
				ctx.ui.notify(
					[
						`OCX 用户配置：${configPath}${ocx.created ? " · 已创建" : " · 已就绪"}`,
						`代理：${ocx.config.ocx.baseUrl}`,
						`账号：${ocx.accounts.filter(isOcxAccountUsable).length} 个可用`,
						`模型：${ocx.catalog.models.filter((model) => !model.disabled).length} 个可用`,
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					[
						message(error),
						"1. npm install -g @bitkyc08/opencodex@2.100.1",
						"2. ocx setup",
						"3. ocx start",
						"4. 回到 Pi 再运行 /ocx-setup",
					].join("\n"),
					"warning",
				);
			}
		},
	});

	pi.registerCommand("init", {
		description: "根据项目材料初始化当前目录或指定目录",
		handler: async (args, ctx) => {
			try {
				const projectRoot = args.trim()
					? await selectProjectRoot(args, ctx)
					: (activeProjectRoot ?? ctx.cwd);
				if (projectRoot) await initializeProject(ctx, projectRoot);
			} catch (error) {
				ctx.ui.notify(message(error), "error");
				ctx.ui.setStatus("smart-workflow", undefined);
			}
		},
	});

	pi.registerCommand("workflow", {
		description: "规划、执行、验收、提交并推送一个通用项目任务",
		handler: async (args, ctx) => {
			try {
				await runWorkflow(ctx, activeProjectRoot ?? ctx.cwd, args.trim() || undefined);
			} catch (error) {
				ctx.ui.notify(message(error), "error");
				ctx.ui.setStatus("smart-workflow", undefined);
			}
		},
	});
}
