import { describe, expect, it } from "vitest";
import { isWorkflowExitInput } from "./workflow-exit.ts";

describe("Smart-Workflow exit input", () => {
	it.each(["exit", "quit"])("handles interactive %s", (text) => {
		expect(isWorkflowExitInput(text, "interactive")).toBe(true);
	});

	it.each([
		["please exit", "interactive"],
		["exit", "rpc"],
		["quit", "extension"],
	] as const)("does not intercept %s from %s", (text, source) => {
		expect(isWorkflowExitInput(text, source)).toBe(false);
	});
});
