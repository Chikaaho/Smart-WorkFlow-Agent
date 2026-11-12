import type { ResolvedWorkflowRoutes } from "./ocx.ts";
import type { DesktopHarnessAdapter, DispatchInput, RequirementDraft, WorkflowReadinessGate } from "./workflow.ts";
import { WorkflowStateError } from "./workflow.ts";

export const GIT_DELIVERY_ACCEPTANCE =
	"若任务产生仓库变更：本任务变更已按项目规范提交并推送到当前远端分支，回执包含提交、推送和工作树状态";
export const WORKFLOW_STATE_SYNC_ACCEPTANCE = "项目要求的后续状态、验收回执和终态已按 Workspace main 规则同步";

export interface WorkflowTaskPlan {
	goal: string;
	acceptance: string[];
	executorPrompt: string;
	executorName?: string;
}

export interface WorkflowTaskPlanningInput {
	taskId: string;
	request: string;
	routes: ResolvedWorkflowRoutes;
	adapter: DesktopHarnessAdapter;
	readiness: WorkflowReadinessGate;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(output: string): UnknownRecord {
	for (const line of output.split(/\r?\n/u).toReversed()) {
		const objectStart = line.indexOf("{");
		if (objectStart < 0) continue;
		try {
			const value: unknown = JSON.parse(line.slice(objectStart));
			if (isRecord(value)) return value;
		} catch {}
	}
	throw new WorkflowStateError("Planner 没有返回可解析的单行 JSON 规划");
}

export function parseWorkflowTaskPlan(output: string): WorkflowTaskPlan {
	const value = readJsonObject(output);
	const goal = typeof value.goal === "string" ? value.goal.trim() : "";
	const executorPrompt = typeof value.executorPrompt === "string" ? value.executorPrompt.trim() : "";
	if (!goal || !executorPrompt) throw new WorkflowStateError("Planner 规划缺少 goal 或 executorPrompt");
	if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) {
		throw new WorkflowStateError("Planner 规划必须包含至少一项验收条件");
	}
	const acceptance = value.acceptance.map((criterion) => {
		if (typeof criterion !== "string" || !criterion.trim()) {
			throw new WorkflowStateError("Planner 规划中的验收条件必须是非空字符串");
		}
		return criterion.trim();
	});
	if (new Set(acceptance).size !== acceptance.length) {
		throw new WorkflowStateError("Planner 规划包含重复的验收条件");
	}
	const executorName = typeof value.executorName === "string" ? value.executorName.trim() : "";
	return {
		goal,
		acceptance: [...acceptance, GIT_DELIVERY_ACCEPTANCE, WORKFLOW_STATE_SYNC_ACCEPTANCE].filter(
			(criterion, index, values) => values.indexOf(criterion) === index,
		),
		executorPrompt: [
			executorPrompt,
			"按 Smart-WorkFlow-Agent-Workspace main 的规则同步本任务后续状态、验收回执和终态。",
			"Git 提交和推送属于本任务交付步骤。产生仓库变更时，按项目提交规范提交本任务文件并推送当前远端分支；回执写明提交、推送和工作树状态。",
		].join("\n"),
		...(executorName ? { executorName } : {}),
	};
}

export async function planWorkflowTask(input: WorkflowTaskPlanningInput): Promise<WorkflowTaskPlan> {
	await input.readiness.assertReady();
	const requirement: RequirementDraft = {
		id: input.taskId,
		revision: 1,
		goal: input.request,
		acceptance: ["输出可供用户确认的目标、验收条件和 Executor 派单"],
	};
	const configuredExecutors = Object.keys(input.routes.executors);
	const dispatchInput: DispatchInput = {
		taskId: `${input.taskId}:planning`,
		role: "planner",
		stage: "planning",
		requirement,
		model: input.routes.roles.planner,
		prompt: [
			"你是 Planner。读取当前项目事实和用户需求，生成执行前规划，不得修改项目。",
			`用户需求：${input.request}`,
			configuredExecutors.length > 0
				? `可用具名 Executor：${configuredExecutors.join("、")}。只有确实需要时才填写 executorName。`
				: "当前没有具名 Executor，不要填写 executorName。",
			"规划必须包含具体目标、可独立核对的验收条件和给 Executor 的完整派单。",
			"规划必须包含 Workspace 后续状态同步和终态回执；如果任务产生仓库变更，提交和推送当前远端分支属于交付步骤。",
			'只输出单行 JSON：{"goal":"...","acceptance":["..."],"executorPrompt":"...","executorName":"可选"}',
		].join("\n"),
	};
	const prepared = await input.adapter.prepare(dispatchInput);
	try {
		const receipt = await input.adapter.dispatch(dispatchInput, prepared);
		if (receipt.taskId !== dispatchInput.taskId || receipt.sessionId !== prepared.sessionId) {
			throw new WorkflowStateError("Planner 规划回执与规划会话不一致");
		}
		const plan = parseWorkflowTaskPlan(receipt.output);
		if (plan.executorName && !input.routes.executors[plan.executorName]) {
			throw new WorkflowStateError(`Planner 选择了未配置的 Executor：${plan.executorName}`);
		}
		return plan;
	} finally {
		await input.adapter.release?.(prepared);
	}
}
