import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export type DesktopHarnessId = "zcode" | "deepseek-harness";
export type WorkflowRole = "planner" | "executor" | "admin";

export interface ModelBinding {
	model: string;
}

export interface WorkflowConfig {
	schemaVersion: 1;
	harness: DesktopHarnessId;
	modelGateway: {
		type: "opencodex";
		required: true;
		installIfMissing: boolean;
	};
	roles: Record<WorkflowRole, ModelBinding>;
	executors: Record<string, ModelBinding>;
}

export interface ConfigIssue {
	path: string;
	code: "invalid_yaml" | "invalid_type" | "missing_field" | "unknown_field" | "invalid_value";
	message: string;
}

export type ConfigResult = { ok: true; value: WorkflowConfig } | { ok: false; issues: ConfigIssue[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkUnknownFields(value: UnknownRecord, allowed: readonly string[], path: string, issues: ConfigIssue[]) {
	const accepted = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (accepted.has(key)) continue;
		issues.push({
			path: path ? `${path}.${key}` : key,
			code: "unknown_field",
			message: `不支持字段 ${path ? `${path}.` : ""}${key}`,
		});
	}
}

function requireRecord(value: unknown, path: string, issues: ConfigIssue[]): UnknownRecord | undefined {
	if (isRecord(value)) return value;
	issues.push({ path, code: "invalid_type", message: `${path} 必须是对象` });
	return undefined;
}

function requireString(value: unknown, path: string, issues: ConfigIssue[]): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	issues.push({
		path,
		code: value === undefined ? "missing_field" : "invalid_type",
		message: `${path} 必须是非空字符串`,
	});
	return undefined;
}

function requireBoolean(value: unknown, path: string, issues: ConfigIssue[]): boolean | undefined {
	if (typeof value === "boolean") return value;
	issues.push({
		path,
		code: value === undefined ? "missing_field" : "invalid_type",
		message: `${path} 必须是布尔值`,
	});
	return undefined;
}

function parseBinding(value: unknown, path: string, issues: ConfigIssue[]): ModelBinding | undefined {
	const record = requireRecord(value, path, issues);
	if (!record) return undefined;
	checkUnknownFields(record, ["model"], path, issues);
	const model = requireString(record.model, `${path}.model`, issues);
	return model ? { model } : undefined;
}

export function parseWorkflowConfig(source: string): ConfigResult {
	let parsed: unknown;
	try {
		parsed = parse(source);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					path: "$",
					code: "invalid_yaml",
					message: error instanceof Error ? error.message : "YAML 无法解析",
				},
			],
		};
	}

	const issues: ConfigIssue[] = [];
	const root = requireRecord(parsed, "$", issues);
	if (!root) return { ok: false, issues };
	checkUnknownFields(root, ["schemaVersion", "harness", "modelGateway", "roles", "executors"], "", issues);

	if (root.schemaVersion !== 1) {
		issues.push({
			path: "schemaVersion",
			code: root.schemaVersion === undefined ? "missing_field" : "invalid_value",
			message: "schemaVersion 当前只支持 1",
		});
	}

	const harness = root.harness;
	if (harness !== "zcode" && harness !== "deepseek-harness") {
		issues.push({
			path: "harness",
			code: harness === undefined ? "missing_field" : "invalid_value",
			message: "harness 必须是 zcode 或 deepseek-harness",
		});
	}

	const gateway = requireRecord(root.modelGateway, "modelGateway", issues);
	let required: boolean | undefined;
	let installIfMissing: boolean | undefined;
	if (gateway) {
		checkUnknownFields(gateway, ["type", "required", "installIfMissing"], "modelGateway", issues);
		if (gateway.type !== "opencodex") {
			issues.push({
				path: "modelGateway.type",
				code: gateway.type === undefined ? "missing_field" : "invalid_value",
				message: "modelGateway.type 当前只支持 opencodex",
			});
		}
		required = requireBoolean(gateway.required, "modelGateway.required", issues);
		installIfMissing = requireBoolean(gateway.installIfMissing, "modelGateway.installIfMissing", issues);
		if (required === false) {
			issues.push({
				path: "modelGateway.required",
				code: "invalid_value",
				message: "modelGateway.required 必须为 true；OCX 未安装并启动时 Pi 不得处理任务",
			});
		}
	}

	const rolesRecord = requireRecord(root.roles, "roles", issues);
	const roleBindings: Partial<Record<WorkflowRole, ModelBinding>> = {};
	if (rolesRecord) {
		checkUnknownFields(rolesRecord, ["planner", "executor", "admin"], "roles", issues);
		for (const role of ["planner", "executor", "admin"] as const) {
			const binding = parseBinding(rolesRecord[role], `roles.${role}`, issues);
			if (binding) roleBindings[role] = binding;
		}
	}

	const executors: Record<string, ModelBinding> = {};
	if (root.executors !== undefined) {
		const executorRecord = requireRecord(root.executors, "executors", issues);
		if (executorRecord) {
			for (const [name, value] of Object.entries(executorRecord)) {
				if (!name.trim()) {
					issues.push({ path: "executors", code: "invalid_value", message: "执行配置名称不能为空" });
					continue;
				}
				const binding = parseBinding(value, `executors.${name}`, issues);
				if (binding) executors[name] = binding;
			}
		}
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			harness: harness as DesktopHarnessId,
			modelGateway: {
				type: "opencodex",
				required: true,
				installIfMissing: installIfMissing as boolean,
			},
			roles: roleBindings as Record<WorkflowRole, ModelBinding>,
			executors,
		},
	};
}

export async function readWorkflowConfig(path: string): Promise<ConfigResult> {
	return parseWorkflowConfig(await readFile(path, "utf8"));
}
