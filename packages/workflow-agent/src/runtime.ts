import type { ResolvedWorkflowRoutes } from "./ocx.ts";
import type { WorkflowRuntimeStore } from "./store.ts";
import {
	type DesktopHarnessAdapter,
	type PlannerReviewDecision,
	type RequirementDraft,
	type WorkflowAttempt,
	WorkflowCoordinator,
	type WorkflowReadinessGate,
	type WorkflowSnapshot,
	WorkflowStateError,
	type WorkflowSupervisor,
} from "./workflow.ts";

export const MAX_WORKFLOW_ATTEMPTS = 60;

export interface PersistentWorkflowRuntimeOptions {
	id: string;
	workspace: string;
	store: WorkflowRuntimeStore;
	routes: ResolvedWorkflowRoutes;
	adapter: DesktopHarnessAdapter;
	supervisor: WorkflowSupervisor;
	readiness: WorkflowReadinessGate;
}

export interface WorkflowRunInput {
	requirement: Omit<RequirementDraft, "revision">;
	prompt: string;
	executorName?: string;
	plannerInstructions?: string;
	maxAttempts?: number;
}

export interface WorkflowAcceptedResult {
	status: "accepted";
	attempt: WorkflowAttempt;
	review: PlannerReviewDecision;
	snapshot: WorkflowSnapshot;
}

export interface WorkflowLimitReachedResult {
	status: "limit_reached";
	attempt: WorkflowAttempt;
	review: PlannerReviewDecision;
	snapshot: WorkflowSnapshot;
	attemptsInRound: number;
	totalAttempts: number;
}

export interface WorkflowCancelledResult {
	status: "cancelled";
	snapshot: WorkflowSnapshot;
	totalAttempts: number;
}

export type WorkflowRunResult = WorkflowAcceptedResult | WorkflowLimitReachedResult | WorkflowCancelledResult;

export interface WorkflowContinuationController {
	onLimitReached(checkpoint: WorkflowLimitReachedResult): Promise<number | undefined>;
}

export class PersistentWorkflowRuntime {
	readonly id: string;
	readonly workspace: string;
	readonly store: WorkflowRuntimeStore;
	readonly coordinator: WorkflowCoordinator;
	#closed = false;

	private constructor(id: string, workspace: string, store: WorkflowRuntimeStore, coordinator: WorkflowCoordinator) {
		this.id = id;
		this.workspace = workspace;
		this.store = store;
		this.coordinator = coordinator;
	}

	static async open(options: PersistentWorkflowRuntimeOptions): Promise<PersistentWorkflowRuntime> {
		await options.store.acquire();
		try {
			const stored = await options.store.load(options.id);
			if (stored && stored.workspace !== options.workspace) {
				throw new WorkflowStateError(`工作流记录属于其他 Workspace：${stored.workspace}`);
			}
			const persist = async (snapshot: WorkflowSnapshot) => {
				await options.store.save(options.id, {
					schemaVersion: 1,
					workspace: options.workspace,
					savedAt: Date.now(),
					snapshot,
				});
			};
			const coordinator = new WorkflowCoordinator(
				options.routes,
				options.adapter,
				options.supervisor,
				options.readiness,
				stored?.snapshot,
				persist,
			);
			const runtime = new PersistentWorkflowRuntime(options.id, options.workspace, options.store, coordinator);
			if (stored && coordinator.snapshot().phase !== stored.snapshot.phase) await runtime.#save();
			return runtime;
		} catch (error) {
			await options.store.release();
			throw error;
		}
	}

	snapshot(): WorkflowSnapshot {
		return this.coordinator.snapshot();
	}

	async runUntilAccepted(input: WorkflowRunInput): Promise<WorkflowAcceptedResult | WorkflowLimitReachedResult>;
	async runUntilAccepted(
		input: WorkflowRunInput,
		continuation: WorkflowContinuationController,
	): Promise<WorkflowAcceptedResult | WorkflowCancelledResult>;
	async runUntilAccepted(
		input: WorkflowRunInput,
		continuation?: WorkflowContinuationController,
	): Promise<WorkflowRunResult> {
		this.#assertOpen();
		let maxAttempts = input.maxAttempts ?? MAX_WORKFLOW_ATTEMPTS;
		this.#assertAttemptLimit(maxAttempts, "maxAttempts");
		await this.#prepareRequirement(input.requirement);
		let attemptBaseline = this.coordinator.snapshot().attempts.length;
		let nextPrompt = this.#latestRepairPrompt() ?? input.prompt;

		while (true) {
			const snapshot = this.coordinator.snapshot();
			if (snapshot.phase === "accepted") return this.#acceptedResult(snapshot);
			if (snapshot.phase === "cancelled") throw new WorkflowStateError("工作流已经取消");
			if (snapshot.phase === "paused") {
				if (snapshot.pausedFrom === "executing") {
					throw new WorkflowStateError("工作流在 Executor 执行中中断，必须先核对宿主历史再继续");
				}
				await this.coordinator.resume();
				continue;
			}
			if (snapshot.phase === "confirmed") {
				if (snapshot.attempts.length - attemptBaseline >= maxAttempts) {
					const checkpoint = this.#limitReachedResult(snapshot, snapshot.attempts.length - attemptBaseline);
					if (!continuation) return checkpoint;
					const additionalAttempts = await continuation.onLimitReached(checkpoint);
					if (additionalAttempts === undefined) {
						await this.coordinator.cancel();
						const cancelled = this.coordinator.snapshot();
						return {
							status: "cancelled",
							snapshot: cancelled,
							totalAttempts: cancelled.attempts.length,
						};
					}
					this.#assertAttemptLimit(additionalAttempts, "新增轮数");
					attemptBaseline = snapshot.attempts.length;
					maxAttempts = additionalAttempts;
					continue;
				}
				const attempt = await this.coordinator.dispatch({
					...(input.executorName ? { executorName: input.executorName } : {}),
					prompt: nextPrompt,
				});
				if (!attempt.supervisor.accepted) {
					throw new WorkflowStateError(`Supervisor 未接受 Executor 回执：${attempt.supervisor.reason}`);
				}
				continue;
			}
			if (snapshot.phase === "pending_review") {
				const review = await this.coordinator.reviewWithPlanner(input.plannerInstructions);
				if (!review.accepted) nextPrompt = review.nextPrompt ?? input.prompt;
				continue;
			}
			throw new WorkflowStateError(`工作流处于无法自动继续的状态：${snapshot.phase}`);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.store.release();
	}

	async #prepareRequirement(requirement: Omit<RequirementDraft, "revision">): Promise<void> {
		const snapshot = this.coordinator.snapshot();
		if (!snapshot.requirement) {
			const drafted = this.coordinator.draft(requirement);
			this.coordinator.confirm(drafted.revision);
			await this.#save();
			return;
		}
		if (
			snapshot.requirement.id !== requirement.id ||
			snapshot.requirement.goal !== requirement.goal ||
			snapshot.requirement.acceptance.length !== requirement.acceptance.length ||
			snapshot.requirement.acceptance.some((item, index) => item !== requirement.acceptance[index])
		) {
			throw new WorkflowStateError("现有运行记录与当前需求或验收条件不一致");
		}
		if (snapshot.phase === "draft") {
			this.coordinator.confirm(snapshot.requirement.revision);
			await this.#save();
		}
	}

	#latestRepairPrompt(): string | undefined {
		return this.coordinator
			.snapshot()
			.reviews.toReversed()
			.find((review) => !review.accepted)?.nextPrompt;
	}

	#acceptedResult(snapshot: WorkflowSnapshot): WorkflowAcceptedResult {
		const attempt = snapshot.attempts.at(-1);
		const review = snapshot.reviews.at(-1);
		if (!attempt || !review?.accepted || review.taskId !== attempt.taskId) {
			throw new WorkflowStateError("已验收状态缺少对应的 Planner 逐项结论");
		}
		return { status: "accepted", attempt, review, snapshot };
	}

	#limitReachedResult(snapshot: WorkflowSnapshot, attemptsInRound: number): WorkflowLimitReachedResult {
		const attempt = snapshot.attempts.at(-1);
		const review = snapshot.reviews.at(-1);
		if (!attempt || !review || review.accepted || review.taskId !== attempt.taskId) {
			throw new WorkflowStateError("达到轮次上限时缺少对应的 Planner 退回结论");
		}
		return {
			status: "limit_reached",
			attempt,
			review,
			snapshot,
			attemptsInRound,
			totalAttempts: snapshot.attempts.length,
		};
	}

	#assertAttemptLimit(value: number, name: string): void {
		if (!Number.isInteger(value) || value < 1 || value > MAX_WORKFLOW_ATTEMPTS) {
			throw new WorkflowStateError(`${name} 必须是 1 到 ${MAX_WORKFLOW_ATTEMPTS} 的整数`);
		}
	}

	async #save(): Promise<void> {
		await this.store.save(this.id, {
			schemaVersion: 1,
			workspace: this.workspace,
			savedAt: Date.now(),
			snapshot: this.coordinator.snapshot(),
		});
	}

	#assertOpen(): void {
		if (this.#closed) throw new WorkflowStateError("工作流运行时已经关闭");
	}
}

export function formatWorkflowLimitReached(checkpoint: WorkflowLimitReachedResult): string {
	const failedCriteria = checkpoint.review.criteria.filter((criterion) => !criterion.accepted);
	return [
		`本轮 ${checkpoint.attemptsInRound} 次额度已用完，累计派单 ${checkpoint.totalAttempts} 次。`,
		`最近一次 Planner 结论：${checkpoint.review.reason}`,
		"未通过项：",
		...failedCriteria.map((criterion) => `- ${criterion.criterion}：${criterion.evidence}`),
	].join("\n");
}
