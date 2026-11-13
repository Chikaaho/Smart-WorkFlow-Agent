import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	assertOcxReady,
	isOcxAccountUsable,
	type OcxAccount,
	type OcxCatalog,
	OcxCli,
	type OcxCommandRunner,
	OcxReadinessError,
	type OcxRuntimeStatus,
	readOcxAccounts,
	readOcxCatalog,
} from "./ocx.ts";

type UnknownRecord = Record<string, unknown>;

export const OCX_USER_CONFIG_FILENAME = "smart-workflow.json";

export interface OcxUserConfig {
	schemaVersion: 1;
	ocx: {
		executable: string;
		baseUrl: string;
		dashboardUrl: string;
		version?: string;
		installMethod?: string;
		configPath?: string;
	};
}

export interface OcxUserIntegration {
	configPath: string;
	config: OcxUserConfig;
	status: OcxRuntimeStatus;
	accounts: OcxAccount[];
	catalog: OcxCatalog;
	runner: OcxCommandRunner;
	created: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, key: string, path: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path}.${key} 必须是非空字符串`);
	return value.trim();
}

function optionalString(record: UnknownRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseOcxUserConfig(value: unknown): OcxUserConfig {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.ocx)) {
		throw new Error("OCX 用户配置必须包含 schemaVersion: 1 和 ocx 对象");
	}
	const executable = requiredString(value.ocx, "executable", "ocx");
	const baseUrl = requiredString(value.ocx, "baseUrl", "ocx");
	const dashboardUrl = requiredString(value.ocx, "dashboardUrl", "ocx");
	const version = optionalString(value.ocx, "version");
	const installMethod = optionalString(value.ocx, "installMethod");
	const configPath = optionalString(value.ocx, "configPath");
	return {
		schemaVersion: 1,
		ocx: {
			executable,
			baseUrl,
			dashboardUrl,
			...(version ? { version } : {}),
			...(installMethod ? { installMethod } : {}),
			...(configPath ? { configPath } : {}),
		},
	};
}

export async function readOcxUserConfig(configPath: string): Promise<OcxUserConfig | undefined> {
	let content: string;
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return parseOcxUserConfig(JSON.parse(content));
	} catch (error) {
		throw new Error(`OCX 用户配置无效：${configPath}`, { cause: error });
	}
}

export async function writeOcxUserConfig(configPath: string, config: OcxUserConfig): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	const temporaryPath = `${configPath}.tmp-${randomUUID()}`;
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, configPath);
}

function configFromStatus(executable: string, status: OcxRuntimeStatus): OcxUserConfig {
	return {
		schemaVersion: 1,
		ocx: {
			executable,
			baseUrl: status.baseUrl ?? "http://127.0.0.1:10100/v1",
			dashboardUrl: status.dashboardUrl ?? "http://localhost:10100/",
			...(status.version ? { version: status.version } : {}),
			...(status.installMethod ? { installMethod: status.installMethod } : {}),
			...(status.configPath ? { configPath: status.configPath } : {}),
		},
	};
}

async function waitForOcxReady(runner: OcxCommandRunner): Promise<OcxRuntimeStatus> {
	try {
		return await assertOcxReady(runner);
	} catch (error) {
		if (!(error instanceof OcxReadinessError) || error.code !== "not_running") throw error;
	}
	try {
		await runner.run(["start"]);
	} catch (error) {
		throw new OcxReadinessError("status_failed", "OCX 代理自动启动失败；请运行 ocx start 查看错误", {
			cause: error,
		});
	}
	let lastError: unknown;
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			return await assertOcxReady(runner);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new OcxReadinessError("status_failed", "OCX 已执行启动命令，但代理仍未就绪", { cause: lastError });
}

export async function ensureOcxUserConfig(input: {
	configPath: string;
	executable?: string;
	runner?: OcxCommandRunner;
}): Promise<OcxUserIntegration> {
	const existing = await readOcxUserConfig(input.configPath);
	const executable = input.executable?.trim() || existing?.ocx.executable || "ocx";
	const runner = input.runner ?? new OcxCli(executable);
	const status = await waitForOcxReady(runner);
	const accounts = await readOcxAccounts(runner);
	if (accounts.filter(isOcxAccountUsable).length === 0) {
		throw new OcxReadinessError("not_configured", "OCX 没有可用账号；请先运行 ocx setup 完成登录或密钥配置");
	}
	const catalog = await readOcxCatalog(runner);
	if (catalog.models.filter((model) => !model.disabled).length === 0) {
		throw new OcxReadinessError("not_configured", "OCX 没有可用模型；请先运行 ocx setup 配置账号和模型");
	}
	const config = configFromStatus(executable, status);
	if (!existing || JSON.stringify(existing) !== JSON.stringify(config)) {
		await writeOcxUserConfig(input.configPath, config);
	}
	return {
		configPath: input.configPath,
		config,
		status,
		accounts,
		catalog,
		runner,
		created: !existing,
	};
}
