import { describe, expect, it } from "vitest";
import type {
	DesktopHarnessAdapter,
	DispatchInput,
	ExecutorReceipt,
	PreparedDispatch,
	WorkflowSupervisor,
} from "../src/workflow.ts";
import { parsePlannerReview, WorkflowCoordinator, WorkflowStateError } from "../src/workflow.ts";

class FakeAdapter implements DesktopHarnessAdapter {
	inputs: DispatchInput[] = [];
	paused: string[] = [];
	cancelled: string[] = [];
	plannerAccepted = true;
	#session = 0;

	async prepare(): Promise<PreparedDispatch> {
		this.#session += 1;
		return { sessionId: `zcode-session-${this.#session}` };
	}

	async dispatch(input: DispatchInput, prepared: PreparedDispatch): Promise<ExecutorReceipt> {
		this.inputs.push(input);
		if (input.role === "planner") {
			return {
				taskId: input.taskId,
				sessionId: prepared.sessionId,
				output: `WORKFLOW_REVIEW ${JSON.stringify({
					accepted: this.plannerAccepted,
					reason: this.plannerAccepted ? "页面证据满足全部条件" : "页码不正确",
					criteria: input.requirement.acceptance.map((criterion) => ({
						criterion,
						accepted: this.plannerAccepted,
						evidence: this.plannerAccepted ? "页面显示目标值" : "页面仍显示第 1 页",
					})),
					...(this.plannerAccepted ? {} : { nextPrompt: "点击下一页后重新读取页码" }),
				})}`,
			};
		}
		return { taskId: input.taskId, sessionId: prepared.sessionId, output: "筛选后第 2 / 2 页" };
	}

	async pause(prepared: PreparedDispatch): Promise<void> {
		this.paused.push(prepared.sessionId);
	}

	async cancel(prepared: PreparedDispatch): Promise<void> {
		this.cancelled.push(prepared.sessionId);
	}
}

const supervisor: WorkflowSupervisor = {
	async start() {
		return { accepted: true, reason: "允许启动" };
	},
	async inspect() {
		return { accepted: true, reason: "回执完整" };
	},
};

const ready = {
	async assertReady() {},
};

const routes = {
	roles: {
		planner: { requested: "gpt-6-luna", selector: "gpt-6-luna", kind: "model" as const },
		executor: {
			requested: "command-code/deepseek-deepseek-v4.1-flash",
			selector: "command-code/deepseek-deepseek-v4.1-flash",
			kind: "model" as const,
		},
		admin: { requested: "gpt-6-luna", selector: "gpt-6-luna", kind: "model" as const },
	},
	executors: {
		ui: { requested: "combo/ui", selector: "combo/ui", kind: "combo" as const },
	},
};

describe("WorkflowCoordinator", () => {
	it("rejects a Planner conclusion that conflicts with its criterion decisions", () => {
		expect(() =>
			parsePlannerReview(
				'WORKFLOW_REVIEW {"accepted":true,"reason":"通过","criteria":[{"criterion":"第二页","accepted":false,"evidence":"仍为第一页"}]}',
				["第二页"],
			),
		).toThrow("总结论与逐项结论不一致");
	});

	it("does not create an Executor dispatch before confirmation", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		workflow.draft({ id: "filter-pagination", goal: "筛选后翻页", acceptance: ["第 2 页保持财务部"] });
		await expect(workflow.dispatch({ executorName: "ui", prompt: "执行页面验收" })).rejects.toBeInstanceOf(
			WorkflowStateError,
		);
		expect(adapter.inputs).toHaveLength(0);
	});

	it("does not dispatch when confirmation withholds Executor delegation", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		const requirement = workflow.draft({ id: "filter", goal: "筛选后翻页", acceptance: ["第二页"] });
		workflow.confirm(requirement.revision, { executorDelegation: false, confirmedAt: 123 });
		await expect(workflow.dispatch({ prompt: "执行" })).rejects.toThrow("没有 Executor 派单授权");
		expect(adapter.inputs).toHaveLength(0);
	});

	it("dispatches the confirmed revision and waits for Planner review", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		const requirement = workflow.draft({
			id: "filter-pagination",
			goal: "筛选后翻页",
			acceptance: ["第 2 页保持财务部"],
		});
		workflow.confirm(requirement.revision);
		const attempt = await workflow.dispatch({ executorName: "ui", prompt: "执行页面验收" });
		expect(adapter.inputs[0]?.model.selector).toBe("combo/ui");
		expect(adapter.inputs[0]?.role).toBe("executor");
		expect(workflow.snapshot().phase).toBe("pending_review");
		const review = await workflow.reviewWithPlanner();
		expect(review.taskId).toBe(attempt.taskId);
		expect(workflow.snapshot().phase).toBe("accepted");
	});

	it("uses the configured Planner model for evidence-based review", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		const requirement = workflow.draft({
			id: "filter-pagination",
			goal: "筛选后翻页",
			acceptance: ["筛选保持", "页码为 2 / 2"],
		});
		workflow.confirm(requirement.revision);
		const attempt = await workflow.dispatch({ prompt: "执行页面验收" });
		const review = await workflow.reviewWithPlanner();
		expect(adapter.inputs[1]).toMatchObject({ role: "planner", model: { selector: "gpt-6-luna" } });
		expect(review).toMatchObject({ taskId: attempt.taskId, accepted: true });
		expect(review.criteria).toHaveLength(2);
		expect(workflow.snapshot().phase).toBe("accepted");
	});

	it("returns a Planner repair prompt without changing acceptance items", async () => {
		const adapter = new FakeAdapter();
		adapter.plannerAccepted = false;
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		const requirement = workflow.draft({
			id: "filter-pagination",
			goal: "筛选后翻页",
			acceptance: ["筛选保持", "页码为 2 / 2"],
		});
		workflow.confirm(requirement.revision);
		await workflow.dispatch({ prompt: "执行页面验收" });
		const review = await workflow.reviewWithPlanner();
		expect(review).toMatchObject({ accepted: false, nextPrompt: "点击下一页后重新读取页码" });
		expect(workflow.snapshot()).toMatchObject({
			phase: "confirmed",
			requirement: { acceptance: ["筛选保持", "页码为 2 / 2"] },
			reviews: [{ accepted: false }],
		});
	});

	it("invalidates confirmation when the draft revision changes", async () => {
		const workflow = new WorkflowCoordinator(routes, new FakeAdapter(), supervisor, ready);
		const first = workflow.draft({ id: "filter-pagination", goal: "筛选后翻页", acceptance: ["第 2 页"] });
		workflow.confirm(first.revision);
		workflow.draft({ id: "filter-pagination", goal: "筛选后翻页并截图", acceptance: ["第 2 页", "有截图"] });
		await expect(workflow.dispatch({ prompt: "执行" })).rejects.toThrow("确认前");
	});

	it("keeps acceptance items when Planner returns an attempt for repair", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		const requirement = workflow.draft({
			id: "filter-pagination",
			goal: "筛选后翻页",
			acceptance: ["筛选保持", "页码为 2 / 2"],
		});
		workflow.confirm(requirement.revision);
		adapter.plannerAccepted = false;
		const attempt = await workflow.dispatch({ prompt: "执行页面验收" });
		await workflow.reviewWithPlanner();
		expect(workflow.snapshot()).toMatchObject({
			phase: "confirmed",
			requirement: { acceptance: ["筛选保持", "页码为 2 / 2"] },
			attempts: [{ taskId: attempt.taskId }],
		});
	});

	it("pauses for takeover, resumes review, and cancels an unaccepted workflow", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, ready);
		const requirement = workflow.draft({ id: "filter", goal: "筛选后翻页", acceptance: ["第二页"] });
		workflow.confirm(requirement.revision);
		await workflow.dispatch({ prompt: "执行" });
		await workflow.takeover();
		expect(workflow.snapshot()).toMatchObject({ phase: "paused", pausedFrom: "pending_review" });
		expect(adapter.paused).toEqual(["zcode-session-1"]);
		await workflow.resume();
		expect(workflow.snapshot().phase).toBe("pending_review");
		await workflow.cancel();
		expect(workflow.snapshot().phase).toBe("cancelled");
		expect(adapter.cancelled).toEqual(["zcode-session-1"]);
	});

	it("restores an in-flight run as paused until host state is reconciled", async () => {
		const restored = new WorkflowCoordinator(routes, new FakeAdapter(), supervisor, ready, {
			phase: "executing",
			confirmedRevision: 1,
			activeSessionId: "zcode-session-before-restart",
			requirement: { id: "filter", revision: 1, goal: "筛选后翻页", acceptance: ["第二页"] },
			attempts: [],
			reviews: [],
		});
		expect(restored.snapshot()).toMatchObject({ phase: "paused", pausedFrom: "executing" });
		await expect(restored.resume()).rejects.toThrow("核对宿主历史");
		restored.reconcileAfterRestart("confirmed");
		expect(restored.snapshot().phase).toBe("confirmed");
	});

	it("blocks dispatch before the Harness when OCX is not ready", async () => {
		const adapter = new FakeAdapter();
		const workflow = new WorkflowCoordinator(routes, adapter, supervisor, {
			async assertReady() {
				throw new Error("OCX 已安装但代理没有运行");
			},
		});
		const requirement = workflow.draft({ id: "filter", goal: "筛选后翻页", acceptance: ["第二页"] });
		workflow.confirm(requirement.revision);
		await expect(workflow.dispatch({ prompt: "执行" })).rejects.toThrow("OCX 已安装但代理没有运行");
		expect(adapter.inputs).toHaveLength(0);
	});
});
