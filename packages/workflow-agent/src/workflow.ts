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
	role: "executor" | "planner";
	stage: "planning" | "execution" | "review";
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
	prompt?: string;
	receipt: ExecutorReceipt;
	supervisor: SupervisorDecision;
}

export interface PlannerCriterionDecision {
	criterion: string;
	accepted: boolean;
	evidence: string;
}

export interface PlannerReviewDecision {
	reviewId: string;
	taskId: string;
	sessionId: string;
	accepted: boolean;
	reason: string;
	criteria: PlannerCriterionDecision[];
	nextPrompt?: string;
	output: string;
}

export interface WorkflowSnapshot {
	phase: WorkflowPhase;
	requirement?: RequirementDraft;
	confirmedRevision?: number;
	authorization?: RequirementAuthorization;
	pausedFrom?: Exclude<WorkflowPhase, "paused" | "cancelled">;
	activeSessionId?: string;
	attempts: WorkflowAttempt[];
	reviews: PlannerReviewDecision[];
}

export class WorkflowStateError extends Error {}

export class WorkflowCoordinator {
	readonly routes: ResolvedWorkflowRoutes;
	readonly adapter: DesktopHarnessAdapter;
	readonly supervisor: WorkflowSupervisor;
	readonly readiness: WorkflowReadinessGate;
	#state: WorkflowSnapshot = { phase: "draft", attempts: [], reviews: [] };
	#attempt = 0;
	#activePrepared?: PreparedDispatch;
	readonly #onSnapshot?: (snapshot: WorkflowSnapshot) => Promise<void>;

	constructor(
		routes: ResolvedWorkflowRoutes,
		adapter: DesktopHarnessAdapter,
		supervisor: WorkflowSupervisor,
		readiness: WorkflowReadinessGate,
		initialState?: WorkflowSnapshot,
		onSnapshot?: (snapshot: WorkflowSnapshot) => Promise<void>,
	) {
		this.routes = routes;
		this.adapter = adapter;
		this.supervisor = supervisor;
		this.readiness = readiness;
		this.#onSnapshot = onSnapshot;
		if (initialState) {
			this.#state = { ...structuredClone(initialState), reviews: structuredClone(initialState.reviews ?? []) };
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
		this.#state = {
			phase: "draft",
			requirement,
			attempts: [...this.#state.attempts],
			reviews: [...this.#state.reviews],
		};
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
			role: "executor",
			stage: "execution",
			requirement,
			...(input.executorName ? { executorName: input.executorName } : {}),
			model,
			prompt: input.prompt,
		};
		if (this.#activePrepared) {
			await this.adapter.release?.(this.#activePrepared);
			this.#activePrepared = undefined;
			this.#state = { ...this.#state, activeSessionId: undefined };
		}
		const prepared = await this.adapter.prepare(dispatchInput);
		this.#activePrepared = prepared;
		this.#state = { ...this.#state, activeSessionId: prepared.sessionId };
		await this.#persist();
		const start = await this.supervisor.start({
			taskId,
			sessionId: prepared.sessionId,
			requirement,
			nextAction: input.prompt,
		});
		if (!start.accepted) {
			await this.adapter.release?.(prepared);
			this.#activePrepared = undefined;
			this.#state = { ...this.#state, activeSessionId: undefined };
			await this.#persist();
			throw new WorkflowStateError(`Supervisor 拒绝启动任务：${start.reason}`);
		}
		this.#state = { ...this.#state, phase: "executing" };
		await this.#persist();
		const receipt = await this.adapter.dispatch(dispatchInput, prepared);
		if (receipt.taskId !== taskId) throw new WorkflowStateError("Executor 回执的任务 ID 与派单不一致");
		if (receipt.sessionId !== prepared.sessionId) throw new WorkflowStateError("Executor 回执的会话 ID 与派单不一致");
		const supervisor = await this.supervisor.inspect({ taskId, requirement, receipt });
		const attempt: WorkflowAttempt = {
			taskId,
			...(input.executorName ? { executorName: input.executorName } : {}),
			model,
			prompt: input.prompt,
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
		await this.#persist();
		return structuredClone(attempt);
	}

	async reviewWithPlanner(additionalInstructions?: string): Promise<PlannerReviewDecision> {
		const requirement = this.#state.requirement;
		const attempt = this.#state.attempts.at(-1);
		if (!requirement || this.#state.phase !== "pending_review" || !attempt?.supervisor.accepted) {
			throw new WorkflowStateError("当前没有可供 Planner 复核的回执");
		}
		const model = this.routes.roles.planner;
		if (!model) throw new WorkflowStateError("未配置 Planner 模型");
		await this.readiness.assertReady();
		const reviewId = `${attempt.taskId}:planner:${this.#state.reviews.length + 1}`;
		const dispatchInput: DispatchInput = {
			taskId: reviewId,
			role: "planner",
			stage: "review",
			requirement,
			model,
			prompt: buildPlannerPrompt(requirement, attempt, additionalInstructions),
		};
		const prepared = await this.adapter.prepare(dispatchInput);
		try {
			const receipt = await this.adapter.dispatch(dispatchInput, prepared);
			if (receipt.taskId !== reviewId || receipt.sessionId !== prepared.sessionId) {
				throw new WorkflowStateError("Planner 回执与复核会话不一致");
			}
			const parsed = parsePlannerReview(receipt.output, requirement.acceptance);
			const review: PlannerReviewDecision = {
				reviewId,
				taskId: attempt.taskId,
				sessionId: prepared.sessionId,
				...parsed,
				output: receipt.output,
			};
			this.#state = { ...this.#state, reviews: [...this.#state.reviews, review] };
			this.#applyPlannerReview(attempt.taskId, review.accepted);
			if (this.#activePrepared) {
				await this.adapter.release?.(this.#activePrepared);
				this.#activePrepared = undefined;
				this.#state = { ...this.#state, activeSessionId: undefined };
			}
			await this.#persist();
			return structuredClone(review);
		} finally {
			await this.adapter.release?.(prepared);
		}
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
		await this.#persist();
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
		await this.#persist();
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
		await this.#persist();
	}

	#applyPlannerReview(taskId: string, accepted: boolean): void {
		if (this.#state.phase !== "pending_review") throw new WorkflowStateError("当前没有可供 Planner 复核的回执");
		const attempt = this.#state.attempts.at(-1);
		if (!attempt || attempt.taskId !== taskId || !attempt.supervisor.accepted) {
			throw new WorkflowStateError("只能复核 Supervisor 已接受的最新回执");
		}
		this.#state = { ...this.#state, phase: accepted ? "accepted" : "confirmed" };
	}

	async #persist(): Promise<void> {
		await this.#onSnapshot?.(this.snapshot());
	}
}

function buildPlannerPrompt(
	requirement: RequirementDraft,
	attempt: WorkflowAttempt,
	additionalInstructions?: string,
): string {
	return [
		"你是 Planner，只负责独立验收 Executor 的实际结果。",
		`目标：${requirement.goal}`,
		"验收条件：",
		...requirement.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
		attempt.prompt ? `Executor 原派单：${attempt.prompt}` : "",
		`Executor 回执：${attempt.receipt.output}`,
		attempt.receipt.browserEvidence?.page ? `Executor 记录的页面证据：${attempt.receipt.browserEvidence.page}` : "",
		`Supervisor 结果：${attempt.supervisor.reason}`,
		"必须独立核对可用的行为证据，不能仅相信 Executor 自述；任务涉及页面时，使用当前 Harness 的浏览器工具读取页面现状。",
		"逐项给出可复核的页面证据。任一条件没有证据或不成立时，accepted 必须为 false，并在 nextPrompt 中写明下一次 Executor 要修复或补证的动作。",
		additionalInstructions?.trim() || "",
		'只输出单行 JSON：{"accepted":true,"reason":"...","criteria":[{"criterion":"原验收条件全文","accepted":true,"evidence":"页面中读到的事实"}],"nextPrompt":"未通过时必填"}',
	]
		.filter(Boolean)
		.join("\n");
}

export function parsePlannerReview(
	output: string,
	acceptance: string[],
): Omit<PlannerReviewDecision, "reviewId" | "taskId" | "sessionId" | "output"> {
	let value: unknown;
	for (const line of output.split(/\r?\n/u).toReversed()) {
		const objectStart = line.indexOf("{");
		if (objectStart < 0) continue;
		try {
			value = JSON.parse(line.slice(objectStart));
			break;
		} catch {}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new WorkflowStateError("Planner 没有返回可解析的单行 JSON 结论");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.accepted !== "boolean" || typeof record.reason !== "string" || !record.reason.trim()) {
		throw new WorkflowStateError("Planner 结论缺少 accepted 或 reason");
	}
	if (!Array.isArray(record.criteria) || record.criteria.length !== acceptance.length) {
		throw new WorkflowStateError("Planner 没有逐项返回全部验收条件");
	}
	const criteria = record.criteria.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new WorkflowStateError("Planner 验收项格式无效");
		}
		const criterion = item as Record<string, unknown>;
		if (
			typeof criterion.criterion !== "string" ||
			typeof criterion.accepted !== "boolean" ||
			typeof criterion.evidence !== "string" ||
			!criterion.evidence.trim()
		) {
			throw new WorkflowStateError("Planner 验收项缺少 criterion、accepted 或 evidence");
		}
		return {
			criterion: criterion.criterion,
			accepted: criterion.accepted,
			evidence: criterion.evidence.trim(),
		};
	});
	const returnedCriteria = new Set(criteria.map((criterion) => criterion.criterion));
	if (
		returnedCriteria.size !== acceptance.length ||
		acceptance.some((criterion) => !returnedCriteria.has(criterion))
	) {
		throw new WorkflowStateError("Planner 返回的验收条件与需求修订不一致");
	}
	const accepted = criteria.every((criterion) => criterion.accepted);
	if (record.accepted !== accepted) throw new WorkflowStateError("Planner 总结论与逐项结论不一致");
	const nextPrompt = typeof record.nextPrompt === "string" ? record.nextPrompt.trim() : "";
	if (!accepted && !nextPrompt) throw new WorkflowStateError("Planner 退回任务时必须给出 nextPrompt");
	return {
		accepted,
		reason: record.reason.trim(),
		criteria,
		...(nextPrompt ? { nextPrompt } : {}),
	};
}
