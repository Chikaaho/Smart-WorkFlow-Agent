import type { ResolvedRoute, ResolvedWorkflowRoutes } from "./ocx.ts";

export type WorkflowPhase =
	| "draft"
	| "confirmed"
	| "executing"
	| "pending_review"
	| "accepted"
	| "paused"
	| "cancelled";

export interface RequirementDraft {
	id: string;
	revision: number;
	goal: string;
	acceptance: string[];
}

export interface RequirementAuthorization {
	revision: number;
	executorDelegation: boolean;
	confirmedAt: number;
}

export interface DispatchInput {
	taskId: string;
	requirement: RequirementDraft;
	executorName?: string;
	model: ResolvedRoute;
	prompt: string;
}

export interface ExecutorReceipt {
	taskId: string;
	sessionId: string;
	output: string;
	browserEvidence?: {
		page?: string;
		screenshot?: string;
	};
}

export interface PreparedDispatch {
	sessionId: string;
}

export interface DesktopHarnessAdapter {
	prepare(input: DispatchInput): Promise<PreparedDispatch>;
	dispatch(input: DispatchInput, prepared: PreparedDispatch): Promise<ExecutorReceipt>;
	release?(prepared: PreparedDispatch): Promise<void>;
	pause?(prepared: PreparedDispatch): Promise<void>;
	resume?(prepared: PreparedDispatch): Promise<void>;
	cancel?(prepared: PreparedDispatch): Promise<void>;
}

export interface SupervisorDecision {
	accepted: boolean;
	reason: string;
}

export interface WorkflowSupervisor {
	start(input: {
		taskId: string;
		sessionId: string;
		requirement: RequirementDraft;
		nextAction: string;
	}): Promise<SupervisorDecision>;
	inspect(input: {
		taskId: string;
		requirement: RequirementDraft;
		receipt: ExecutorReceipt;
	}): Promise<SupervisorDecision>;
}

export interface WorkflowReadinessGate {
	assertReady(): Promise<void>;
}

export interface WorkflowAttempt {
	taskId: string;
	executorName?: string;
	model: ResolvedRoute;
	receipt: ExecutorReceipt;
	supervisor: SupervisorDecision;
}

export interface WorkflowSnapshot {
	phase: WorkflowPhase;
	requirement?: RequirementDraft;
	confirmedRevision?: number;
	authorization?: RequirementAuthorization;
	pausedFrom?: Exclude<WorkflowPhase, "paused" | "cancelled">;
	activeSessionId?: string;
	attempts: WorkflowAttempt[];
}

export class WorkflowStateError extends Error {}

export class WorkflowCoordinator {
	readonly routes: ResolvedWorkflowRoutes;
	readonly adapter: DesktopHarnessAdapter;
	readonly supervisor: WorkflowSupervisor;
	readonly readiness: WorkflowReadinessGate;
	#state: WorkflowSnapshot = { phase: "draft", attempts: [] };
	#attempt = 0;
	#activePrepared?: PreparedDispatch;

	constructor(
		routes: ResolvedWorkflowRoutes,
		adapter: DesktopHarnessAdapter,
		supervisor: WorkflowSupervisor,
		readiness: WorkflowReadinessGate,
		initialState?: WorkflowSnapshot,
	) {
		this.routes = routes;
		this.adapter = adapter;
		this.supervisor = supervisor;
		this.readiness = readiness;
		if (initialState) {
			this.#state = structuredClone(initialState);
			this.#attempt = initialState.attempts.length;
			if (initialState.activeSessionId) this.#activePrepared = { sessionId: initialState.activeSessionId };
			if (initialState.phase === "executing") {
				this.#state = { ...this.#state, phase: "paused", pausedFrom: "executing" };
			}
		}
	}

	snapshot(): WorkflowSnapshot {
		return structuredClone(this.#state);
	}

	draft(input: Omit<RequirementDraft, "revision">): RequirementDraft {
		const previousRevision = this.#state.requirement?.revision ?? 0;
		const requirement = { ...input, revision: previousRevision + 1 };
		this.#state = { phase: "draft", requirement, attempts: [...this.#state.attempts] };
		return structuredClone(requirement);
	}

	confirm(revision: number, options: { executorDelegation?: boolean; confirmedAt?: number } = {}): void {
		const requirement = this.#state.requirement;
		if (!requirement || requirement.revision !== revision) {
			throw new WorkflowStateError(`无法确认修订 ${revision}：当前修订不是该版本`);
		}
		if (this.#state.phase !== "draft") throw new WorkflowStateError("当前需求不在待确认状态");
		this.#state = {
			...this.#state,
			phase: "confirmed",
			confirmedRevision: revision,
			authorization: {
				revision,
				executorDelegation: options.executorDelegation ?? true,
				confirmedAt: options.confirmedAt ?? Date.now(),
			},
		};
	}

	async dispatch(input: { executorName?: string; prompt: string }): Promise<WorkflowAttempt> {
		const requirement = this.#state.requirement;
		if (!requirement || this.#state.phase !== "confirmed") {
			throw new WorkflowStateError("需求确认前不得派发 Executor");
		}
		if (this.#state.confirmedRevision !== requirement.revision) {
			throw new WorkflowStateError("当前确认不适用于最新需求修订");
		}
		if (
			this.#state.authorization?.revision !== requirement.revision ||
			!this.#state.authorization.executorDelegation
		) {
			throw new WorkflowStateError("当前需求没有 Executor 派单授权");
		}

		const model = input.executorName ? this.routes.executors[input.executorName] : this.routes.roles.executor;
		if (!model) throw new WorkflowStateError(`未配置具名 Executor：${input.executorName}`);
		await this.readiness.assertReady();

		this.#attempt += 1;
		const taskId = `${requirement.id}:r${requirement.revision}:a${this.#attempt}`;
		const dispatchInput: DispatchInput = {
			taskId,
			requirement,
			...(input.executorName ? { executorName: input.executorName } : {}),
			model,
			prompt: input.prompt,
		};
		const prepared = await this.adapter.prepare(dispatchInput);
		this.#activePrepared = prepared;
		this.#state = { ...this.#state, activeSessionId: prepared.sessionId };
		const start = await this.supervisor.start({
			taskId,
			sessionId: prepared.sessionId,
			requirement,
			nextAction: input.prompt,
		});
		if (!start.accepted) {
			await this.adapter.release?.(prepared);
			throw new WorkflowStateError(`Supervisor 拒绝启动任务：${start.reason}`);
		}
		this.#state = { ...this.#state, phase: "executing" };
		const receipt = await this.adapter.dispatch(dispatchInput, prepared);
		if (receipt.taskId !== taskId) throw new WorkflowStateError("Executor 回执的任务 ID 与派单不一致");
		if (receipt.sessionId !== prepared.sessionId) throw new WorkflowStateError("Executor 回执的会话 ID 与派单不一致");
		const supervisor = await this.supervisor.inspect({ taskId, requirement, receipt });
		const attempt: WorkflowAttempt = {
			taskId,
			...(input.executorName ? { executorName: input.executorName } : {}),
			model,
			receipt,
			supervisor,
		};
		const completedPhase = supervisor.accepted ? "pending_review" : "confirmed";
		this.#state =
			this.#state.phase === "cancelled"
				? { ...this.#state, attempts: [...this.#state.attempts, attempt] }
				: this.#state.phase === "paused"
					? {
							...this.#state,
							pausedFrom: completedPhase,
							attempts: [...this.#state.attempts, attempt],
						}
					: {
							...this.#state,
							phase: completedPhase,
							attempts: [...this.#state.attempts, attempt],
						};
		return structuredClone(attempt);
	}

	async takeover(): Promise<void> {
		await this.pause();
	}

	async pause(): Promise<void> {
		if (this.#state.phase === "paused") return;
		if (!(["confirmed", "executing", "pending_review"] as WorkflowPhase[]).includes(this.#state.phase)) {
			throw new WorkflowStateError("当前工作流不能暂停");
		}
		if (this.#activePrepared) await this.adapter.pause?.(this.#activePrepared);
		this.#state = {
			...this.#state,
			phase: "paused",
			pausedFrom: this.#state.phase as Exclude<WorkflowPhase, "paused" | "cancelled">,
		};
	}

	async resume(): Promise<void> {
		if (this.#state.phase !== "paused" || !this.#state.pausedFrom) {
			throw new WorkflowStateError("当前工作流没有暂停");
		}
		if (this.#state.pausedFrom === "executing" && this.#activePrepared) {
			if (!this.adapter.resume) throw new WorkflowStateError("恢复执行前必须核对宿主历史和实际结果");
			await this.adapter.resume(this.#activePrepared);
		}
		const phase = this.#state.pausedFrom;
		const { pausedFrom: _pausedFrom, ...state } = this.#state;
		this.#state = { ...state, phase };
	}

	reconcileAfterRestart(phase: "confirmed" | "pending_review"): void {
		if (this.#state.phase !== "paused" || this.#state.pausedFrom !== "executing") {
			throw new WorkflowStateError("当前没有待核对的中断执行");
		}
		const { pausedFrom: _pausedFrom, ...state } = this.#state;
		this.#state = { ...state, phase };
	}

	async cancel(): Promise<void> {
		if (this.#state.phase === "cancelled") return;
		if (this.#state.phase === "accepted") throw new WorkflowStateError("已验收工作流不能取消");
		if (this.#activePrepared) {
			if (this.adapter.cancel) await this.adapter.cancel(this.#activePrepared);
			else await this.adapter.release?.(this.#activePrepared);
		}
		this.#state = { ...this.#state, phase: "cancelled" };
	}

	review(taskId: string, accepted: boolean): void {
		if (this.#state.phase !== "pending_review") throw new WorkflowStateError("当前没有可供 Planner 复核的回执");
		const attempt = this.#state.attempts.at(-1);
		if (!attempt || attempt.taskId !== taskId || !attempt.supervisor.accepted) {
			throw new WorkflowStateError("只能复核 Supervisor 已接受的最新回执");
		}
		this.#state = { ...this.#state, phase: accepted ? "accepted" : "confirmed" };
	}
}
