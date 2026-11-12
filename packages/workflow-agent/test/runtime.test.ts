import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentWorkflowRuntime } from "../src/runtime.ts";
import { WorkflowRuntimeStore } from "../src/store.ts";
import type {
	DesktopHarnessAdapter,
	DispatchInput,
	ExecutorReceipt,
	PreparedDispatch,
	WorkflowSupervisor,
} from "../src/workflow.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class LoopAdapter implements DesktopHarnessAdapter {
	inputs: DispatchInput[] = [];
	plannerReviews = 0;
	readonly acceptAfter: number;
	#session = 0;

	constructor(acceptAfter = 2) {
		this.acceptAfter = acceptAfter;
	}

	async prepare(): Promise<PreparedDispatch> {
		this.#session += 1;
		return { sessionId: `session-${this.#session}` };
	}

	async dispatch(input: DispatchInput, prepared: PreparedDispatch): Promise<ExecutorReceipt> {
		this.inputs.push(input);
		if (input.role === "executor") {
			return { taskId: input.taskId, sessionId: prepared.sessionId, output: `Executor ${input.prompt}` };
		}
		this.plannerReviews += 1;
		const accepted = this.plannerReviews >= this.acceptAfter;
		return {
			taskId: input.taskId,
			sessionId: prepared.sessionId,
			output: `WORKFLOW_REVIEW ${JSON.stringify({
				accepted,
				reason: accepted ? "第二次页面验收通过" : "第一次仍在第 1 页",
				criteria: input.requirement.acceptance.map((criterion) => ({
					criterion,
					accepted,
					evidence: accepted ? "页面显示 2 / 2" : "页面显示 1 / 2",
				})),
				...(accepted ? {} : { nextPrompt: "保持筛选条件并点击下一页" }),
			})}`,
		};
	}

	async release(): Promise<void> {}
}

const supervisor: WorkflowSupervisor = {
	async start() {
		return { accepted: true, reason: "允许启动" };
	},
	async inspect() {
		return { accepted: true, reason: "回执可进入 Planner 验收" };
	},
};

const routes = {
	roles: {
		planner: { requested: "planner", selector: "planner", kind: "model" as const },
		executor: { requested: "executor", selector: "executor", kind: "model" as const },
		admin: { requested: "admin", selector: "admin", kind: "model" as const },
	},
	executors: {},
};

const readiness = { async assertReady() {} };

async function createStore(): Promise<WorkflowRuntimeStore> {
	const directory = await mkdtemp(join(tmpdir(), "workflow-runtime-test-"));
	temporaryDirectories.push(directory);
	return new WorkflowRuntimeStore(directory);
}

describe("PersistentWorkflowRuntime", () => {
	it("caps the configured Executor attempt limit at 60", async () => {
		const store = await createStore();
		const runtime = await PersistentWorkflowRuntime.open({
			id: "attempt-limit",
			workspace: "/workspace",
			store,
			routes,
			adapter: new LoopAdapter(),
			supervisor,
			readiness,
		});
		await expect(
			runtime.runUntilAccepted({
				requirement: { id: "large-task", goal: "完成大任务", acceptance: ["全部验收项通过"] },
				prompt: "开始执行",
				maxAttempts: 61,
			}),
		).rejects.toThrow("1 到 60");
		await runtime.close();
	});

	it("reports each limit checkpoint and repeats with the user-provided attempt count until accepted", async () => {
		const store = await createStore();
		const adapter = new LoopAdapter(5);
		const runtime = await PersistentWorkflowRuntime.open({
			id: "continued-large-task",
			workspace: "/workspace",
			store,
			routes,
			adapter,
			supervisor,
			readiness,
		});
		const checkpoints: Array<{ attemptsInRound: number; totalAttempts: number }> = [];
		const result = await runtime.runUntilAccepted(
			{
				requirement: { id: "large-task", goal: "完成大任务", acceptance: ["全部验收项通过"] },
				prompt: "开始执行",
				maxAttempts: 2,
			},
			{
				onLimitReached: async (checkpoint) => {
					checkpoints.push({
						attemptsInRound: checkpoint.attemptsInRound,
						totalAttempts: checkpoint.totalAttempts,
					});
					return 2;
				},
			},
		);
		expect(result.status).toBe("accepted");
		expect(result.snapshot.attempts).toHaveLength(5);
		expect(checkpoints).toEqual([
			{ attemptsInRound: 2, totalAttempts: 2 },
			{ attemptsInRound: 2, totalAttempts: 4 },
		]);
		await runtime.close();
	});

	it("persists cancellation when the user declines to continue at a limit checkpoint", async () => {
		const store = await createStore();
		const runtime = await PersistentWorkflowRuntime.open({
			id: "cancelled-at-limit",
			workspace: "/workspace",
			store,
			routes,
			adapter: new LoopAdapter(5),
			supervisor,
			readiness,
		});
		const result = await runtime.runUntilAccepted(
			{
				requirement: { id: "large-task", goal: "完成大任务", acceptance: ["全部验收项通过"] },
				prompt: "开始执行",
				maxAttempts: 1,
			},
			{ onLimitReached: async () => undefined },
		);
		expect(result).toMatchObject({ status: "cancelled", totalAttempts: 1, snapshot: { phase: "cancelled" } });
		expect((await store.load("cancelled-at-limit"))?.snapshot.phase).toBe("cancelled");
		await runtime.close();
	});

	it("persists Planner review, redispatches its repair prompt, and restores the accepted result", async () => {
		const store = await createStore();
		const adapter = new LoopAdapter();
		const runtime = await PersistentWorkflowRuntime.open({
			id: "filter-pagination",
			workspace: "/workspace",
			store,
			routes,
			adapter,
			supervisor,
			readiness,
		});
		const input = {
			requirement: { id: "filter", goal: "筛选后翻页", acceptance: ["页码为 2 / 2"] },
			prompt: "选择财务部并翻页",
			maxAttempts: 3,
		};
		const result = await runtime.runUntilAccepted(input);
		if (result.status !== "accepted") throw new Error("测试工作流未进入 accepted");
		expect(result.snapshot).toMatchObject({
			phase: "accepted",
			attempts: [{}, {}],
			reviews: [{ accepted: false }, { accepted: true }],
		});
		expect(adapter.inputs.filter((item) => item.role === "executor").map((item) => item.prompt)).toEqual([
			"选择财务部并翻页",
			"保持筛选条件并点击下一页",
		]);
		await runtime.close();

		const restoredAdapter = new LoopAdapter();
		const restored = await PersistentWorkflowRuntime.open({
			id: "filter-pagination",
			workspace: "/workspace",
			store,
			routes,
			adapter: restoredAdapter,
			supervisor,
			readiness,
		});
		const restoredResult = await restored.runUntilAccepted(input);
		if (restoredResult.status !== "accepted") throw new Error("恢复后的工作流未进入 accepted");
		expect(restoredResult.review.accepted).toBe(true);
		expect(restoredAdapter.inputs).toHaveLength(0);
		await restored.close();
	});
});
