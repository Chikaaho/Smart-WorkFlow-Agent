import type { ResolvedRoute } from "../ocx.ts";
import type { DesktopHarnessAdapter, DispatchInput, ExecutorReceipt, PreparedDispatch } from "../workflow.ts";

export interface DeepSeekModelBinding {
	provider: string;
	model: string;
	reasoningEffort?: string;
}

export interface DeepSeekDesktopRequest {
	workspacePath: string;
	model: DeepSeekModelBinding;
	prompt: string;
	resultMarker: string;
	timeoutMs?: number;
}

export interface DeepSeekDesktopResult {
	marker: string;
	output: string;
	workspacePath: string;
	selectedModel: DeepSeekModelBinding;
	toolNames: string[];
}

export interface DeepSeekDesktopDriver {
	prepare(request: Pick<DeepSeekDesktopRequest, "workspacePath" | "model">): Promise<{ sessionId: string }>;
	run(request: DeepSeekDesktopRequest & { sessionId: string }): Promise<DeepSeekDesktopResult>;
	release?(sessionId: string): Promise<void>;
	pause?(sessionId: string): Promise<void>;
	resume?(sessionId: string): Promise<void>;
	cancel?(sessionId: string): Promise<void>;
}

export class DeepSeekDesktopAdapter implements DesktopHarnessAdapter {
	readonly workspacePath: string;
	readonly driver: DeepSeekDesktopDriver;
	readonly resolveModelBinding: (route: ResolvedRoute) => Promise<DeepSeekModelBinding>;
	readonly timeoutMs?: number;
	readonly requiredToolPrefix?: string;

	constructor(options: {
		workspacePath: string;
		driver: DeepSeekDesktopDriver;
		resolveModelBinding: (route: ResolvedRoute) => Promise<DeepSeekModelBinding>;
		timeoutMs?: number;
		requiredToolPrefix?: string;
	}) {
		this.workspacePath = options.workspacePath;
		this.driver = options.driver;
		this.resolveModelBinding = options.resolveModelBinding;
		this.timeoutMs = options.timeoutMs;
		this.requiredToolPrefix = options.requiredToolPrefix;
	}

	async prepare(input: DispatchInput): Promise<PreparedDispatch> {
		const model = await this.resolveModelBinding(input.model);
		return await this.driver.prepare({ workspacePath: this.workspacePath, model });
	}

	async dispatch(input: DispatchInput, prepared: PreparedDispatch): Promise<ExecutorReceipt> {
		const marker = `WORKFLOW_${input.taskId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
		const model = await this.resolveModelBinding(input.model);
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
		const result = await this.driver.run({
			workspacePath: this.workspacePath,
			sessionId: prepared.sessionId,
			model,
			prompt,
			resultMarker: marker,
			...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
		});
		if (result.marker !== marker) throw new Error("DeepSeek Harness 返回了其他任务的结果标记");
		if (
			result.selectedModel.provider !== model.provider ||
			result.selectedModel.model !== model.model ||
			result.selectedModel.reasoningEffort !== model.reasoningEffort
		) {
			throw new Error("DeepSeek Harness 实际模型与派单绑定不一致");
		}
		const requiredToolPrefix = this.requiredToolPrefix;
		if (
			input.stage !== "planning" &&
			requiredToolPrefix &&
			!result.toolNames.some((name) => name.startsWith(requiredToolPrefix))
		) {
			throw new Error(`DeepSeek Harness 没有调用要求的工具：${requiredToolPrefix}*`);
		}
		return { taskId: input.taskId, sessionId: prepared.sessionId, output: result.output };
	}

	async release(prepared: PreparedDispatch): Promise<void> {
		await this.driver.release?.(prepared.sessionId);
	}

	async pause(prepared: PreparedDispatch): Promise<void> {
		if (!this.driver.pause) throw new Error("DeepSeek Harness 驱动不支持暂停");
		await this.driver.pause(prepared.sessionId);
	}

	async resume(prepared: PreparedDispatch): Promise<void> {
		if (!this.driver.resume) throw new Error("DeepSeek Harness 中断后需要先核对页面与工程状态，再派恢复单");
		await this.driver.resume(prepared.sessionId);
	}

	async cancel(prepared: PreparedDispatch): Promise<void> {
		if (this.driver.cancel) await this.driver.cancel(prepared.sessionId);
		else await this.driver.release?.(prepared.sessionId);
	}
}
