import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOcxUserConfig, readOcxUserConfig } from "../src/ocx-user-config.ts";

describe("OCX user configuration", () => {
	it("creates a global integration file after OCX is configured", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-ocx-config-"));
		const configPath = join(root, "smart-workflow.json");
		const calls: string[][] = [];
		try {
			const integration = await ensureOcxUserConfig({
				configPath,
				runner: {
					async run(args) {
						calls.push([...args]);
						if (args[0] === "status") {
							return JSON.stringify({
								proxy: { running: true, health: { ok: true } },
								listen: { hostname: "127.0.0.1", port: 10100 },
								dashboard: { url: "http://localhost:10100/" },
								paths: { config: "/users/demo/.opencodex/config.json" },
								versionSkew: { cliVersion: "2.100.1" },
								install: { method: "npm" },
							});
						}
						if (args[0] === "account") {
							return JSON.stringify({
								accounts: [{ provider: "openai", active: true, health: "Healthy" }],
							});
						}
						if (args[0] === "models") {
							return JSON.stringify([
								{
									provider: "openai",
									id: "gpt-6-luna",
									namespaced: "gpt-6-luna",
									disabled: false,
								},
							]);
						}
						return JSON.stringify({ combos: [] });
					},
				},
			});
			expect(integration.created).toBe(true);
			expect(calls).toEqual([
				["status", "--json"],
				["account", "list", "--json"],
				["models", "live", "--json"],
				["combo", "list", "--json"],
			]);
			expect(await readOcxUserConfig(configPath)).toEqual({
				schemaVersion: 1,
				ocx: {
					executable: "ocx",
					baseUrl: "http://127.0.0.1:10100/v1",
					dashboardUrl: "http://localhost:10100/",
					version: "2.100.1",
					installMethod: "npm",
					configPath: "/users/demo/.opencodex/config.json",
				},
			});
			if (process.platform !== "win32") expect((await stat(configPath)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(integration.config);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not create a user file before an enabled model exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-ocx-config-"));
		const configPath = join(root, "smart-workflow.json");
		try {
			await expect(
				ensureOcxUserConfig({
					configPath,
					runner: {
						async run(args) {
							if (args[0] === "status") {
								return JSON.stringify({ proxy: { running: true, health: { ok: true } } });
							}
							if (args[0] === "account") {
								return JSON.stringify({ accounts: [{ provider: "openai", active: true }] });
							}
							if (args[0] === "models") return "[]";
							return JSON.stringify({ combos: [] });
						},
					},
				}),
			).rejects.toMatchObject({ code: "not_configured" });
			expect(await readOcxUserConfig(configPath)).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not create a user file before an account is ready", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-ocx-config-"));
		const configPath = join(root, "smart-workflow.json");
		try {
			await expect(
				ensureOcxUserConfig({
					configPath,
					runner: {
						async run(args) {
							if (args[0] === "status") {
								return JSON.stringify({ proxy: { running: true, health: { ok: true } } });
							}
							if (args[0] === "account") return JSON.stringify({ accounts: [] });
							throw new Error(`unexpected command: ${args.join(" ")}`);
						},
					},
				}),
			).rejects.toMatchObject({ code: "not_configured" });
			expect(await readOcxUserConfig(configPath)).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
