import { describe, expect, it } from "vitest";
import {
	GIT_DELIVERY_ACCEPTANCE,
	parseWorkflowTaskPlan,
	planWorkflowTask,
	WORKFLOW_STATE_SYNC_ACCEPTANCE,
} from "../src/planner.ts";
import type { DesktopHarnessAdapter, DispatchInput, ExecutorReceipt, PreparedDispatch } from "../src/workflow.ts";

class PlanningAdapter implements DesktopHarnessAdapter {
	input?: DispatchInput;
	released?: PreparedDispatch;

	async prepare(): Promise<PreparedDispatch> {
		return { sessionId: "planner-session" };
	}

	async dispatch(input: DispatchInput, prepared: PreparedDispatch): Promise<ExecutorReceipt> {
		this.input = input;
		return {
			taskId: input.taskId,
			sessionId: prepared.sessionId,
			output:
				'WORKFLOW_PLAN {"goal":"修复筛选翻页","acceptance":["筛选保持","第二页正确"],"executorPrompt":"修改并验证页面","executorName":"ui"}',
		};
	}

	async release(prepared: PreparedDispatch): Promise<void> {
		this.released = prepared;
	}
}

const routes = {
	roles: {
		planner: { requested: "planner", selector: "planner", kind: "model" as const },
		executor: { requested: "executor", selector: "executor", kind: "model" as const },
		admin: { requested: "admin", selector: "admin", kind: "model" as const },
	},
	executors: {
		ui: { requested: "ui", selector: "ui", kind: "model" as const },
	},
};

describe("workflow task planning", () => {
	it("parses a plan and adds Git delivery to acceptance and Executor instructions", () => {
		const plan = parseWorkflowTaskPlan(
			'PLAN {"goal":"完成任务","acceptance":["功能通过"],"executorPrompt":"实现并测试"}',
		);
		expect(plan.acceptance).toEqual(["功能通过", GIT_DELIVERY_ACCEPTANCE, WORKFLOW_STATE_SYNC_ACCEPTANCE]);
		expect(plan.executorPrompt).toContain("同步本任务后续状态、验收回执和终态");
		expect(plan.executorPrompt).toContain("提交本任务文件并推送当前远端分支");
	});

	it("rejects incomplete Planner output", () => {
		expect(() => parseWorkflowTaskPlan('{"goal":"完成任务","acceptance":[]}')).toThrow("executorPrompt");
	});

	it("uses the Planner route, skips execution, and releases the planning session", async () => {
		const adapter = new PlanningAdapter();
		const plan = await planWorkflowTask({
			taskId: "task-1",
			request: "修复筛选翻页",
			routes,
			adapter,
			readiness: { async assertReady() {} },
		});
		expect(adapter.input).toMatchObject({ role: "planner", stage: "planning", model: { selector: "planner" } });
		expect(adapter.released).toEqual({ sessionId: "planner-session" });
		expect(plan.executorName).toBe("ui");
	});
});
