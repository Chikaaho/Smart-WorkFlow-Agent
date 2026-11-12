import {
	formatWorkflowLimitReached,
	MAX_WORKFLOW_ATTEMPTS,
	type WorkflowLimitReachedResult,
} from "@earendil-works/pi-workflow-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function promptForAdditionalWorkflowAttempts(
	ctx: ExtensionContext,
	checkpoint: WorkflowLimitReachedResult,
): Promise<number | undefined> {
	ctx.ui.notify(formatWorkflowLimitReached(checkpoint), "warning");
	const shouldContinue = await ctx.ui.confirm("已达到本轮上限", "是否继续执行？选择否将终止任务。");
	if (!shouldContinue) return undefined;

	while (true) {
		const value = await ctx.ui.input("输入新增轮数", `1-${MAX_WORKFLOW_ATTEMPTS}，例如 20`);
		if (value === undefined) return undefined;
		const attempts = Number(value.trim());
		if (Number.isInteger(attempts) && attempts >= 1 && attempts <= MAX_WORKFLOW_ATTEMPTS) return attempts;
		ctx.ui.notify(`请输入 1 到 ${MAX_WORKFLOW_ATTEMPTS} 的整数`, "error");
	}
}
