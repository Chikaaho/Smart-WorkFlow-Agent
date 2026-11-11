import { describe, expect, it } from "vitest";
import { parseWorkflowConfig } from "../src/config.ts";

const VALID = `
schemaVersion: 1
harness: zcode
modelGateway:
  type: opencodex
  required: true
  installIfMissing: false
roles:
  planner:
    model: gpt-6-luna
  executor:
    model: command-code/deepseek-deepseek-v4.1-flash
  admin:
    model: gpt-6-luna
executors:
  ui:
    model: combo/ui
`;

describe("parseWorkflowConfig", () => {
	it("parses role and named executor bindings", () => {
		const result = parseWorkflowConfig(VALID);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.harness).toBe("zcode");
		expect(result.value.roles.executor.model).toBe("command-code/deepseek-deepseek-v4.1-flash");
		expect(result.value.executors.ui?.model).toBe("combo/ui");
	});

	it("reports field paths for invalid configuration", () => {
		const result = parseWorkflowConfig(
			VALID.replace("harness: zcode", "harness: browser").replace("  admin:\n", "  extra: true\n  admin:\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["harness", "roles.extra"]));
	});

	it("requires OCX before Pi can process tasks", () => {
		const result = parseWorkflowConfig(VALID.replace("  required: true", "  required: false"));
		expect(result).toMatchObject({
			ok: false,
			issues: [{ path: "modelGateway.required", code: "invalid_value" }],
		});
	});
});
