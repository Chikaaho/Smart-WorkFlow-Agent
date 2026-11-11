import { spawn } from "node:child_process";
import type { ExecutorReceipt, RequirementDraft, SupervisorDecision, WorkflowSupervisor } from "./workflow.ts";

type UnknownRecord = Record<string, unknown>;

export interface SupervisorEventRunner {
	run(event: UnknownRecord): Promise<unknown>;
}

export interface WorkspaceSupervisorOptions {
	root: string;
	stateDir: string;
	workspace: string;
	host: string;
	python?: string;
	timeoutMs?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PythonSupervisorEventRunner implements SupervisorEventRunner {
	readonly options: WorkspaceSupervisorOptions;

	constructor(options: WorkspaceSupervisorOptions) {
		this.options = options;
	}

	async run(event: UnknownRecord): Promise<unknown> {
		const script = `${this.options.root}/.codex/governance/execution-supervisor.py`;
		const python = this.options.python ?? "python3";
		const timeoutMs = this.options.timeoutMs ?? 10_000;
		return await new Promise((resolve, reject) => {
			const child = spawn(
				python,
				[script, "--root", this.options.root, "--state-dir", this.options.stateDir, "event"],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else {
					try {
						resolve(JSON.parse(stdout));
					} catch (parseError) {
						reject(new Error("Workspace Supervisor 返回了无效 JSON", { cause: parseError }));
					}
				}
			};
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				finish(new Error(`Workspace Supervisor 在 ${timeoutMs}ms 内没有返回`));
			}, timeoutMs);
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error) => finish(error));
			child.on("close", (code) => {
				if (code !== 0) finish(new Error(stderr.trim() || `Workspace Supervisor 退出码 ${code}`));
				else finish();
			});
			child.stdin.end(JSON.stringify(event));
		});
	}
}

export class WorkspaceSupervisor implements WorkflowSupervisor {
	readonly runner: SupervisorEventRunner;
	readonly workspace: string;
	readonly host: string;

	constructor(options: { runner: SupervisorEventRunner; workspace: string; host: string }) {
		this.runner = options.runner;
		this.workspace = options.workspace;
		this.host = options.host;
	}

	async start(input: {
		taskId: string;
		sessionId: string;
		requirement: RequirementDraft;
		nextAction: string;
	}): Promise<SupervisorDecision> {
		return await this.#send(input.sessionId, {
			event_type: "TASK_STARTED",
			event_id: this.#eventId(input.taskId, "start"),
			task_id: input.taskId,
			contract_revision: 0,
			terminal_payload: {
				next_action: input.nextAction,
				progress_fingerprint: `${input.taskId}:draft-r${input.requirement.revision}`,
			},
		});
	}

	async inspect(input: {
		taskId: string;
		requirement: RequirementDraft;
		receipt: ExecutorReceipt;
	}): Promise<SupervisorDecision> {
		return await this.#send(input.receipt.sessionId, {
			event_type: "TURN_ENDED",
			event_id: this.#eventId(input.taskId, "turn"),
			task_id: input.taskId,
			contract_revision: 1,
			terminal_payload: {
				schema: "agent-coding-engine.executor-terminal.v2",
				role: "executor",
				state: "TASK_COMPLETED",
				task_level: "M",
				evidence: [input.receipt.output],
			},
		});
	}

	#eventId(taskId: string, phase: string): string {
		return `${taskId}:${phase}`;
	}

	async #send(threadId: string, event: UnknownRecord): Promise<SupervisorDecision> {
		const value = await this.runner.run({
			schema: "agent-coding-engine.supervisor-event.v1",
			host: this.host,
			workspace: this.workspace,
			thread_id: threadId,
			active_role: "executor",
			...event,
		});
		if (!isRecord(value) || typeof value.decision !== "string") {
			throw new Error("Workspace Supervisor 决定缺少 decision");
		}
		const reason =
			typeof value.reason === "string"
				? value.reason
				: typeof value.reason_code === "string"
					? value.reason_code
					: value.decision;
		return { accepted: value.decision === "allow", reason };
	}
}
