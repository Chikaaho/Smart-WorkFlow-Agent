import { describe, expect, it } from "vitest";
import {
	ZCodeDesktopAdapter,
	type ZCodeDesktopDriver,
	type ZCodeDesktopRequest,
	type ZCodeDesktopResult,
} from "../src/desktop/zcode.ts";
import type { DispatchInput } from "../src/workflow.ts";

const binding = {
	providerId: "opencode-go-chat",
	providerName: "OpenCode(Chat)",
	modelId: "deepseek-v4.1-flash",
	selector: "opencode-go-chat/deepseek-v4.1-flash",
};

class FakeDriver implements ZCodeDesktopDriver {
	request?: ZCodeDesktopRequest & { sessionId: string };

	async prepare() {
		return { sessionId: "zcode-session-1" };
	}

	async run(request: ZCodeDesktopRequest & { sessionId: string }): Promise<ZCodeDesktopResult> {
		this.request = request;
		return {
			marker: request.resultMarker,
			output: `${request.resultMarker} {"accepted":true}`,
			workspacePath: request.workspacePath,
		};
	}
}

describe("ZCodeDesktopAdapter", () => {
	it("marks Planner sessions and requires Browser Use evidence when configured", async () => {
		const driver = new FakeDriver();
		const adapter = new ZCodeDesktopAdapter({
			workspacePath: "/workspace",
			driver,
			resolveModelBinding: async () => binding,
			requireBrowserEvidence: true,
		});
		const input: DispatchInput = {
			taskId: "filter:r1:a1:planner:1",
			role: "planner",
			requirement: { id: "filter", revision: 1, goal: "筛选后翻页", acceptance: ["第二页"] },
			model: { requested: "planner", selector: "planner", kind: "model" },
			prompt: "独立验收页面",
		};
		const prepared = await adapter.prepare(input);
		await adapter.dispatch(input, prepared);
		expect(driver.request).toMatchObject({ requireBrowserEvidence: true });
		expect(driver.request?.prompt).toContain("本会话角色：规划验收（Planner）");
	});
});
