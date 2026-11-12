import type { ResolvedRoute } from "../ocx.ts";
import type { DesktopHarnessAdapter, DispatchInput, ExecutorReceipt, PreparedDispatch } from "../workflow.ts";
import type { ZCodeModelBinding } from "./zcode-model.ts";

export interface ZCodeDesktopRequest {
	workspacePath: string;
	model: ZCodeModelBinding;
	prompt: string;
	resultMarker: string;
	requireBrowserEvidence?: boolean;
	timeoutMs?: number;
}

export interface ZCodeDesktopResult {
	marker: string;
	output: string;
	workspacePath: string;
}

export interface ZCodeDesktopDriver {
	prepare(request: Pick<ZCodeDesktopRequest, "workspacePath" | "model">): Promise<{ sessionId: string }>;
	run(request: ZCodeDesktopRequest & { sessionId: string }): Promise<ZCodeDesktopResult>;
	release?(sessionId: string): Promise<void>;
	pause?(sessionId: string): Promise<void>;
	resume?(sessionId: string): Promise<void>;
	cancel?(sessionId: string): Promise<void>;
}

export class ZCodeDesktopAdapter implements DesktopHarnessAdapter {
	readonly workspacePath: string;
	readonly driver: ZCodeDesktopDriver;
	readonly resolveModelBinding: (route: ResolvedRoute) => Promise<ZCodeModelBinding>;
	readonly timeoutMs?: number;
	readonly requireBrowserEvidence: boolean;

	constructor(options: {
		workspacePath: string;
		driver: ZCodeDesktopDriver;
		resolveModelBinding: (route: ResolvedRoute) => Promise<ZCodeModelBinding>;
		timeoutMs?: number;
		requireBrowserEvidence?: boolean;
	}) {
		this.workspacePath = options.workspacePath;
		this.driver = options.driver;
		this.resolveModelBinding = options.resolveModelBinding;
		this.timeoutMs = options.timeoutMs;
		this.requireBrowserEvidence = options.requireBrowserEvidence ?? false;
	}

	async prepare(input: DispatchInput): Promise<PreparedDispatch> {
		const model = await this.resolveModelBinding(input.model);
		return await this.driver.prepare({ workspacePath: this.workspacePath, model });
	}

	async dispatch(input: DispatchInput, prepared: PreparedDispatch): Promise<ExecutorReceipt> {
		const marker = `WORKFLOW_${input.taskId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
		const roleName = input.role === "planner" ? "规划验收（Planner）" : "执行（Executor）";
		const completionInstruction =
			input.stage === "planning"
				? `完成后仅输出一行：${marker} {"goal":"...","acceptance":["..."],"executorPrompt":"...","executorName":"可选"}。标记后的 JSON 必须是完整规划，不能换成状态摘要。`
				: `完成后输出以 ${marker} 开头的单行结果。`;
		const prompt = [
			`本会话角色：${roleName}。`,
			`任务 ID：${input.taskId}`,
			`需求修订：${input.requirement.revision}`,
			input.prompt,
			completionInstruction,
		].join("\n");
		const model = await this.resolveModelBinding(input.model);
		const result = await this.driver.run({
			workspacePath: this.workspacePath,
			sessionId: prepared.sessionId,
			model,
			prompt,
			resultMarker: marker,
			...(this.requireBrowserEvidence && input.stage !== "planning" ? { requireBrowserEvidence: true } : {}),
			...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
		});
		if (result.marker !== marker) throw new Error("ZCode 返回了其他任务的结果标记");
		return { taskId: input.taskId, sessionId: prepared.sessionId, output: result.output };
	}

	async release(prepared: PreparedDispatch): Promise<void> {
		await this.driver.release?.(prepared.sessionId);
	}

	async pause(prepared: PreparedDispatch): Promise<void> {
		if (!this.driver.pause) throw new Error("ZCode 驱动不支持暂停");
		await this.driver.pause(prepared.sessionId);
	}

	async resume(prepared: PreparedDispatch): Promise<void> {
		if (!this.driver.resume) throw new Error("ZCode 中断后需要先核对页面与工程状态，再派恢复单");
		await this.driver.resume(prepared.sessionId);
	}

	async cancel(prepared: PreparedDispatch): Promise<void> {
		if (this.driver.cancel) await this.driver.cancel(prepared.sessionId);
		else await this.driver.release?.(prepared.sessionId);
	}
}
