import { describe, expect, it } from "vitest";
import type { WorkflowConfig } from "../src/config.ts";
import {
	assertOcxReady,
	isOcxAccountUsable,
	parseOcxAccounts,
	parseOcxCombos,
	parseOcxModels,
	resolveDeepSeekWorkflowRoutes,
	resolveWorkflowRoutes,
} from "../src/ocx.ts";

const config: WorkflowConfig = {
	schemaVersion: 1,
	harness: "zcode",
	modelGateway: { type: "opencodex", required: true, installIfMissing: false },
	roles: {
		planner: { model: "gpt-6-luna" },
		executor: { model: "command-code/deepseek-deepseek-v4.1-flash" },
		admin: { model: "gpt-6-luna" },
	},
	executors: { ui: { model: "combo/ui" } },
};

describe("OCX catalog", () => {
	it("requires a running healthy proxy", async () => {
		const ready = await assertOcxReady({
			async run(args) {
				expect(args).toEqual(["status", "--json"]);
				return JSON.stringify({
					proxy: { running: true, health: { ok: true } },
					versionSkew: { cliVersion: "2.100.1" },
					install: { method: "npm" },
				});
			},
		});
		expect(ready).toEqual({ running: true, healthy: true, version: "2.100.1", installMethod: "npm" });

		await expect(
			assertOcxReady({
				async run() {
					return JSON.stringify({ proxy: { running: false, health: { ok: false } } });
				},
			}),
		).rejects.toMatchObject({ code: "not_running" });
	});

	it("keeps enabled state and resolves model and combo routes", () => {
		const models = parseOcxModels([
			{ provider: "openai", id: "gpt-6-luna", namespaced: "gpt-6-luna", disabled: false },
			{
				provider: "command-code",
				id: "deepseek/deepseek-v4.1-flash",
				namespaced: "command-code/deepseek-deepseek-v4.1-flash",
				disabled: false,
			},
		]);
		const combos = parseOcxCombos({ combos: [{ id: "ui", strategy: "failover", disabled: false }] });
		const result = resolveWorkflowRoutes(config, { models, combos });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.routes.executors.ui).toMatchObject({ requested: "combo/ui", selector: "combo/ui", kind: "combo" });
	});

	it("accepts only active signed-in accounts", () => {
		const accounts = parseOcxAccounts({
			accounts: [
				{ provider: "openai", active: true, health: "Healthy" },
				{ provider: "command-code", active: true, needsReauth: true },
				{ provider: "deepseek", active: false },
			],
		});
		expect(accounts.filter(isOcxAccountUsable).map((account) => account.provider)).toEqual(["openai"]);
	});

	it("reports a missing combo without falling back", () => {
		const models = parseOcxModels([
			{ provider: "openai", id: "gpt-6-luna", namespaced: "gpt-6-luna", disabled: false },
			{
				provider: "command-code",
				id: "deepseek/deepseek-v4.1-flash",
				namespaced: "command-code/deepseek-deepseek-v4.1-flash",
				disabled: false,
			},
		]);
		const result = resolveWorkflowRoutes(config, { models, combos: [] });
		expect(result).toMatchObject({
			ok: false,
			issues: [{ path: "executors.ui.model", code: "missing_combo" }],
		});
	});

	it("keeps DeepSeek Harness on its native DeepSeek provider", () => {
		const deepSeekConfig: WorkflowConfig = {
			...config,
			harness: "deepseek-harness",
			roles: {
				planner: { model: "deepseek-official/deepseek-flash" },
				executor: { model: "deepseek-official/deepseek-flash" },
				admin: { model: "deepseek-official/deepseek-flash" },
			},
			executors: { ui: { model: "deepseek-official/deepseek-flash" } },
		};
		const result = resolveDeepSeekWorkflowRoutes(deepSeekConfig);
		expect(result).toMatchObject({
			ok: true,
			routes: {
				roles: { executor: { provider: "deepseek-official", modelId: "deepseek-flash" } },
			},
		});

		const invalid = resolveDeepSeekWorkflowRoutes({
			...deepSeekConfig,
			roles: { ...deepSeekConfig.roles, executor: { model: "command-code/deepseek-deepseek-v4.1-flash" } },
		});
		expect(invalid).toMatchObject({
			ok: false,
			issues: [{ path: "roles.executor.model", code: "unsupported_harness_model" }],
		});
	});
});
