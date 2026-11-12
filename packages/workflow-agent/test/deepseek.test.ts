import { describe, expect, it } from "vitest";
import {
	DeepSeekDesktopAdapter,
	type DeepSeekDesktopDriver,
	type DeepSeekDesktopRequest,
	type DeepSeekDesktopResult,
	type DeepSeekModelBinding,
} from "../src/desktop/deepseek.ts";
import type { DispatchInput } from "../src/workflow.ts";

const route = {
	requested: "deepseek-official/deepseek-flash",
	selector: "deepseek-official/deepseek-flash",
	kind: "model" as const,
	provider: "deepseek-official",
	modelId: "deepseek-flash",
};

const binding: DeepSeekModelBinding = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "high",
};

const input: DispatchInput = {
	taskId: "filter:r1:a1",
	role: "executor",
	stage: "execution",
	requirement: {
		id: "filter",
		revision: 1,
		goal: "筛选后翻页",
		acceptance: ["第二页仍为财务部"],
	},
	model: route,
	prompt: "操作可见浏览器",
};

class FakeDriver implements DeepSeekDesktopDriver {
	prepared?: DeepSeekModelBinding;
	request?: DeepSeekDesktopRequest & { sessionId: string };
	selected: DeepSeekModelBinding = binding;

	async prepare(request: Pick<DeepSeekDesktopRequest, "workspacePath" | "model">) {
		this.prepared = request.model;
		return { sessionId: "deepseek-session-1" };
	}

	async run(request: DeepSeekDesktopRequest & { sessionId: string }): Promise<DeepSeekDesktopResult> {
		this.request = request;
		return {
			marker: request.resultMarker,
			output: `${request.resultMarker} {"page":"2 / 2"}`,
			workspacePath: request.workspacePath,
			selectedModel: this.selected,
			toolNames: ["mcp__chrome-devtools-mcp__navigate_page"],
		};
	}
}

describe("DeepSeekDesktopAdapter", () => {
	it("binds and verifies the requested model before returning a receipt", async () => {
		const driver = new FakeDriver();
		const adapter = new DeepSeekDesktopAdapter({
			workspacePath: "/workspace",
			driver,
			resolveModelBinding: async () => binding,
			requiredToolPrefix: "mcp__chrome-devtools-mcp__",
		});
		const prepared = await adapter.prepare(input);
		const receipt = await adapter.dispatch(input, prepared);
		expect(driver.prepared).toEqual(binding);
		expect(receipt).toMatchObject({ taskId: input.taskId, sessionId: "deepseek-session-1" });
	});

	it("rejects a result from a different actual model", async () => {
		const driver = new FakeDriver();
		driver.selected = { ...binding, model: "deepseek-v4-pro" };
		const adapter = new DeepSeekDesktopAdapter({
			workspacePath: "/workspace",
			driver,
			resolveModelBinding: async () => binding,
		});
		const prepared = await adapter.prepare(input);
		await expect(adapter.dispatch(input, prepared)).rejects.toThrow("实际模型与派单绑定不一致");
	});

	it("requires the complete plan JSON in the planning result marker", async () => {
		const driver = new FakeDriver();
		const adapter = new DeepSeekDesktopAdapter({
			workspacePath: "/workspace",
			driver,
			resolveModelBinding: async () => binding,
			requiredToolPrefix: "mcp__chrome-devtools-mcp__",
		});
		const prepared = await adapter.prepare({ ...input, role: "planner", stage: "planning" });
		await adapter.dispatch({ ...input, role: "planner", stage: "planning" }, prepared);
		expect(driver.request?.prompt).toContain("标记后的 JSON 必须是完整规划，不能换成状态摘要");
	});
});
