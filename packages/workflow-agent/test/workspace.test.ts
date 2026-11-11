import { describe, expect, it } from "vitest";
import type { SupervisorEventRunner } from "../src/workspace.ts";
import { WorkspaceSupervisor } from "../src/workspace.ts";

class RecordingRunner implements SupervisorEventRunner {
	events: Record<string, unknown>[] = [];

	async run(event: Record<string, unknown>): Promise<unknown> {
		this.events.push(event);
		return {
			decision: "allow",
			reason_code: event.event_type === "TASK_STARTED" ? "LEASE_CREATED" : "TERMINAL_ALLOWED",
		};
	}
}

describe("WorkspaceSupervisor", () => {
	it("sends a start event before a terminal event with stable identity", async () => {
		const runner = new RecordingRunner();
		const supervisor = new WorkspaceSupervisor({
			runner,
			workspace: "/workspace",
			host: "zcode",
		});
		const requirement = { id: "filter", revision: 1, goal: "筛选后翻页", acceptance: ["第 2 页"] };
		expect(
			await supervisor.start({
				taskId: "task-1",
				sessionId: "thread-1",
				requirement,
				nextAction: "执行页面操作",
			}),
		).toMatchObject({
			accepted: true,
		});
		expect(
			await supervisor.inspect({
				taskId: "task-1",
				requirement,
				receipt: { taskId: "task-1", sessionId: "thread-1", output: "通过" },
			}),
		).toMatchObject({ accepted: true });
		expect(runner.events.map((event) => event.event_type)).toEqual(["TASK_STARTED", "TURN_ENDED"]);
		expect(runner.events[0]).toMatchObject({ host: "zcode", thread_id: "thread-1", active_role: "executor" });
		expect(runner.events[1]).toMatchObject({
			terminal_payload: { schema: "agent-coding-engine.executor-terminal.v2", state: "TASK_COMPLETED" },
		});
		const restarted = new WorkspaceSupervisor({ runner, workspace: "/workspace", host: "zcode" });
		await restarted.start({ taskId: "task-1", sessionId: "thread-1", requirement, nextAction: "执行页面操作" });
		expect(runner.events[2]?.event_id).toBe(runner.events[0]?.event_id);
	});
});
