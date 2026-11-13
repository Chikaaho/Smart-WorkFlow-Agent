import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelBinding, WorkflowConfig, WorkflowRole } from "./config.ts";

const execFileAsync = promisify(execFile);

type UnknownRecord = Record<string, unknown>;

export interface OcxModel {
	provider: string;
	id: string;
	namespaced: string;
	disabled: boolean;
}

export interface OcxCombo {
	id: string;
	selector: string;
	disabled: boolean;
	strategy?: string;
}

export interface OcxCatalog {
	models: OcxModel[];
	combos: OcxCombo[];
}

export interface OcxAccount {
	provider: string;
	active: boolean;
	paused: boolean;
	needsReauth: boolean;
	health?: string;
}

export interface OcxRuntimeStatus {
	running: boolean;
	healthy: boolean;
	version?: string;
	installMethod?: string;
	baseUrl?: string;
	dashboardUrl?: string;
	configPath?: string;
}

export interface OcxCommandRunner {
	run(args: readonly string[]): Promise<string>;
}

export interface RouteIssue {
	path: string;
	model: string;
	code: "missing_model" | "disabled_model" | "missing_combo" | "disabled_combo" | "unsupported_harness_model";
	message: string;
}

export interface ResolvedRoute {
	requested: string;
	selector: string;
	kind: "model" | "combo";
	provider?: string;
	modelId?: string;
}

export type RouteResolution = { ok: true; route: ResolvedRoute } | { ok: false; issue: RouteIssue };

export interface ResolvedWorkflowRoutes {
	roles: Record<WorkflowRole, ResolvedRoute>;
	executors: Record<string, ResolvedRoute>;
}

export type WorkflowRouteResult = { ok: true; routes: ResolvedWorkflowRoutes } | { ok: false; issues: RouteIssue[] };

export type OcxReadinessErrorCode =
	| "not_installed"
	| "not_running"
	| "not_configured"
	| "unhealthy"
	| "invalid_status"
	| "status_failed";

export class OcxReadinessError extends Error {
	readonly code: OcxReadinessErrorCode;

	constructor(code: OcxReadinessErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string, source: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${source} 返回了无效 JSON`, { cause: error });
	}
}

function readString(record: UnknownRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export function parseOcxRuntimeStatus(value: unknown): OcxRuntimeStatus {
	if (!isRecord(value) || !isRecord(value.proxy) || typeof value.proxy.running !== "boolean") {
		throw new Error("ocx status --json 缺少 proxy.running");
	}
	const health = value.proxy.health;
	if (!isRecord(health) || typeof health.ok !== "boolean") {
		throw new Error("ocx status --json 缺少 proxy.health.ok");
	}
	const version = isRecord(value.versionSkew) ? readString(value.versionSkew, "cliVersion") : undefined;
	const installMethod = isRecord(value.install) ? readString(value.install, "method") : undefined;
	const dashboardUrl = isRecord(value.dashboard) ? readString(value.dashboard, "url") : undefined;
	const configPath = isRecord(value.paths) ? readString(value.paths, "config") : undefined;
	const hostname = isRecord(value.listen) ? readString(value.listen, "hostname") : undefined;
	const port = isRecord(value.listen) && typeof value.listen.port === "number" ? value.listen.port : undefined;
	const proxyHost = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
	const baseUrl = proxyHost && port ? `http://${proxyHost}:${port}/v1` : undefined;
	return {
		running: value.proxy.running,
		healthy: health.ok,
		...(version ? { version } : {}),
		...(installMethod ? { installMethod } : {}),
		...(baseUrl ? { baseUrl } : {}),
		...(dashboardUrl ? { dashboardUrl } : {}),
		...(configPath ? { configPath } : {}),
	};
}

export async function assertOcxReady(runner: OcxCommandRunner = new OcxCli()): Promise<OcxRuntimeStatus> {
	let output: string;
	try {
		output = await runner.run(["status", "--json"]);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new OcxReadinessError("not_installed", "未找到 OCX CLI；安装并启动 OCX 后 Pi 才能处理任务", {
				cause: error,
			});
		}
		throw new OcxReadinessError("status_failed", "无法读取 OCX 代理状态；请先运行 ocx status", {
			cause: error,
		});
	}

	let status: OcxRuntimeStatus;
	try {
		status = parseOcxRuntimeStatus(parseJson(output, "ocx status --json"));
	} catch (error) {
		throw new OcxReadinessError("invalid_status", "OCX 状态输出无效，Pi 已停止派单", { cause: error });
	}
	if (!status.running) {
		throw new OcxReadinessError("not_running", "OCX 已安装但代理没有运行；请先执行 ocx start");
	}
	if (!status.healthy) {
		throw new OcxReadinessError("unhealthy", "OCX 代理健康检查未通过；修复后才能由 Pi 处理任务");
	}
	return status;
}

export class OcxReadinessGate {
	readonly runner: OcxCommandRunner;

	constructor(runner: OcxCommandRunner = new OcxCli()) {
		this.runner = runner;
	}

	async assertReady(): Promise<void> {
		await assertOcxReady(this.runner);
	}
}

export function parseOcxModels(value: unknown): OcxModel[] {
	if (!Array.isArray(value)) throw new Error("ocx models live --json 必须返回数组");
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`OCX 模型目录第 ${index + 1} 项不是对象`);
		const provider = readString(entry, "provider");
		const id = readString(entry, "id");
		const namespaced = readString(entry, "namespaced");
		if (!provider || !id || !namespaced || typeof entry.disabled !== "boolean") {
			throw new Error(`OCX 模型目录第 ${index + 1} 项缺少 provider、id、namespaced 或 disabled`);
		}
		return { provider, id, namespaced, disabled: entry.disabled };
	});
}

export function parseOcxCombos(value: unknown): OcxCombo[] {
	if (!isRecord(value) || !Array.isArray(value.combos)) {
		throw new Error("ocx combo list --json 必须返回包含 combos 数组的对象");
	}
	return value.combos.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`OCX 组合目录第 ${index + 1} 项不是对象`);
		const publicId = readString(entry, "selector") ?? readString(entry, "publicModelId");
		const rawId = readString(entry, "id") ?? readString(entry, "name") ?? publicId;
		if (!rawId) throw new Error(`OCX 组合目录第 ${index + 1} 项缺少 id`);
		const id = rawId.startsWith("combo/") ? rawId.slice("combo/".length) : rawId;
		const selector = publicId?.startsWith("combo/") ? publicId : `combo/${id}`;
		const strategy = readString(entry, "strategy");
		const disabled = entry.disabled === true || entry.enabled === false;
		return { id, selector, disabled, ...(strategy ? { strategy } : {}) };
	});
}

export function parseOcxAccounts(value: unknown): OcxAccount[] {
	if (!isRecord(value) || !Array.isArray(value.accounts)) {
		throw new Error("ocx account list --json 必须返回包含 accounts 数组的对象");
	}
	return value.accounts.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`OCX 账号目录第 ${index + 1} 项不是对象`);
		const provider = readString(entry, "provider");
		if (!provider || typeof entry.active !== "boolean") {
			throw new Error(`OCX 账号目录第 ${index + 1} 项缺少 provider 或 active`);
		}
		const health = readString(entry, "health");
		return {
			provider,
			active: entry.active,
			paused: entry.paused === true,
			needsReauth: entry.needsReauth === true,
			...(health ? { health } : {}),
		};
	});
}

export function isOcxAccountUsable(account: OcxAccount): boolean {
	return (
		account.active &&
		!account.paused &&
		!account.needsReauth &&
		(!account.health || account.health.toLowerCase() === "healthy")
	);
}

export class OcxCli implements OcxCommandRunner {
	readonly executable: string;

	constructor(executable = "ocx") {
		this.executable = executable;
	}

	async run(args: readonly string[]): Promise<string> {
		const result = await execFileAsync(this.executable, [...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		return result.stdout;
	}
}

export async function readOcxCatalog(runner: OcxCommandRunner = new OcxCli()): Promise<OcxCatalog> {
	const [modelsJson, combosJson] = await Promise.all([
		runner.run(["models", "live", "--json"]),
		runner.run(["combo", "list", "--json"]),
	]);
	return {
		models: parseOcxModels(parseJson(modelsJson, "ocx models live --json")),
		combos: parseOcxCombos(parseJson(combosJson, "ocx combo list --json")),
	};
}

export async function readOcxAccounts(runner: OcxCommandRunner = new OcxCli()): Promise<OcxAccount[]> {
	return parseOcxAccounts(parseJson(await runner.run(["account", "list", "--json"]), "ocx account list --json"));
}

export function resolveModelBinding(binding: ModelBinding, catalog: OcxCatalog, path: string): RouteResolution {
	const requested = binding.model;
	if (requested.startsWith("combo/")) {
		const combo = catalog.combos.find((candidate) => candidate.selector === requested);
		if (!combo) {
			return {
				ok: false,
				issue: {
					path,
					model: requested,
					code: "missing_combo",
					message: `${path} 引用的 OCX 组合 ${requested} 不存在`,
				},
			};
		}
		if (combo.disabled) {
			return {
				ok: false,
				issue: {
					path,
					model: requested,
					code: "disabled_combo",
					message: `${path} 引用的 OCX 组合 ${requested} 已禁用`,
				},
			};
		}
		return { ok: true, route: { requested, selector: combo.selector, kind: "combo" } };
	}

	const model = catalog.models.find(
		(candidate) =>
			candidate.namespaced === requested || (candidate.namespaced === candidate.id && candidate.id === requested),
	);
	if (!model) {
		return {
			ok: false,
			issue: {
				path,
				model: requested,
				code: "missing_model",
				message: `${path} 引用的 OCX 模型 ${requested} 不存在`,
			},
		};
	}
	if (model.disabled) {
		return {
			ok: false,
			issue: {
				path,
				model: requested,
				code: "disabled_model",
				message: `${path} 引用的 OCX 模型 ${requested} 已禁用`,
			},
		};
	}
	return {
		ok: true,
		route: {
			requested,
			selector: model.namespaced,
			kind: "model",
			provider: model.provider,
			modelId: model.id,
		},
	};
}

export function resolveWorkflowRoutes(config: WorkflowConfig, catalog: OcxCatalog): WorkflowRouteResult {
	const issues: RouteIssue[] = [];
	const roles: Partial<Record<WorkflowRole, ResolvedRoute>> = {};
	for (const role of ["planner", "executor", "admin"] as const) {
		const result = resolveModelBinding(config.roles[role], catalog, `roles.${role}.model`);
		if (result.ok) roles[role] = result.route;
		else issues.push(result.issue);
	}

	const executors: Record<string, ResolvedRoute> = {};
	for (const [name, binding] of Object.entries(config.executors)) {
		const result = resolveModelBinding(binding, catalog, `executors.${name}.model`);
		if (result.ok) executors[name] = result.route;
		else issues.push(result.issue);
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		routes: {
			roles: roles as Record<WorkflowRole, ResolvedRoute>,
			executors,
		},
	};
}

function resolveDeepSeekBinding(binding: ModelBinding, path: string): RouteResolution {
	const separator = binding.model.indexOf("/");
	const provider = separator > 0 ? binding.model.slice(0, separator) : "";
	const modelId = separator > 0 ? binding.model.slice(separator + 1) : "";
	if (provider !== "deepseek-official" || !modelId) {
		return {
			ok: false,
			issue: {
				path,
				model: binding.model,
				code: "unsupported_harness_model",
				message: `${path} 在 DeepSeek Harness 中只能使用 deepseek-official/<model>`,
			},
		};
	}
	return {
		ok: true,
		route: {
			requested: binding.model,
			selector: binding.model,
			kind: "model",
			provider,
			modelId,
		},
	};
}

export function resolveDeepSeekWorkflowRoutes(config: WorkflowConfig): WorkflowRouteResult {
	const issues: RouteIssue[] = [];
	const roles: Partial<Record<WorkflowRole, ResolvedRoute>> = {};
	for (const role of ["planner", "executor", "admin"] as const) {
		const result = resolveDeepSeekBinding(config.roles[role], `roles.${role}.model`);
		if (result.ok) roles[role] = result.route;
		else issues.push(result.issue);
	}

	const executors: Record<string, ResolvedRoute> = {};
	for (const [name, binding] of Object.entries(config.executors)) {
		const result = resolveDeepSeekBinding(binding, `executors.${name}.model`);
		if (result.ok) executors[name] = result.route;
		else issues.push(result.issue);
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		routes: {
			roles: roles as Record<WorkflowRole, ResolvedRoute>,
			executors,
		},
	};
}
