import { describe, expect, it } from "vitest";
import {
	resolveChromeExecutable,
	resolveDeepSeekInstallation,
	resolveZCodeInstallation,
} from "../src/desktop/platform-paths.ts";

function available(...paths: string[]): (path: string) => Promise<boolean> {
	const entries = new Set(paths);
	return async (path) => entries.has(path);
}

describe("desktop platform paths", () => {
	it("finds Chrome in the Windows per-user installation", async () => {
		const executable = String.raw`C:\Users\tester\AppData\Local\Google\Chrome\Application\chrome.exe`;
		await expect(
			resolveChromeExecutable({
				platform: "win32",
				env: { LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local` },
				exists: available(executable),
			}),
		).resolves.toBe(executable);
	});

	it("honors the explicit Chrome executable", async () => {
		const executable = String.raw`D:\Apps\Chrome\chrome.exe`;
		await expect(
			resolveChromeExecutable({
				platform: "win32",
				env: { SMART_WORKFLOW_CHROME_EXECUTABLE: executable },
				exists: available(executable),
			}),
		).resolves.toBe(executable);
	});

	it("resolves the Windows ZCode runtime and personal provider config", async () => {
		const resources = String.raw`C:\Users\tester\AppData\Local\Programs\ZCode\resources`;
		const agentExecutable = String.raw`C:\Users\tester\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs`;
		const builtinProviderConfig = String.raw`C:\Users\tester\AppData\Local\Programs\ZCode\resources\config\provider\zcode-builtin.json`;
		const personalProviderConfig = String.raw`C:\Users\tester\.zcode\v2\provider_config.json`;
		const result = await resolveZCodeInstallation({
			platform: "win32",
			env: { LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local` },
			homeDirectory: String.raw`C:\Users\tester`,
			exists: available(agentExecutable, builtinProviderConfig, personalProviderConfig),
		});
		expect(result).toEqual({
			resourcesDirectory: resources,
			agentExecutable,
			builtinProviderConfig,
			personalProviderConfig,
		});
	});

	it("uses the configured ZCode resources directory", async () => {
		const resources = String.raw`D:\ZCode\resources`;
		const agentExecutable = String.raw`D:\ZCode\resources\glm\zcode.cjs`;
		const builtinProviderConfig = String.raw`D:\ZCode\resources\config\provider\zcode-builtin.json`;
		const personalProviderConfig = String.raw`D:\Profiles\zcode-provider.json`;
		const result = await resolveZCodeInstallation({
			platform: "win32",
			env: {
				SMART_WORKFLOW_ZCODE_RESOURCES: resources,
				SMART_WORKFLOW_ZCODE_PERSONAL_PROVIDER_CONFIG: personalProviderConfig,
			},
			exists: available(agentExecutable, builtinProviderConfig, personalProviderConfig),
		});
		expect(result.resourcesDirectory).toBe(resources);
		expect(result.personalProviderConfig).toBe(personalProviderConfig);
	});

	it("resolves the Windows DeepSeek Desktop Host layout", async () => {
		const applicationDirectory = String.raw`C:\Users\tester\AppData\Local\Programs\DeepSeek Harness`;
		const executable = String.raw`C:\Users\tester\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`;
		const appAsar = String.raw`C:\Users\tester\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`;
		const entry = String.raw`C:\Users\tester\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`;
		const packageManager = String.raw`C:\Users\tester\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`;
		const runtimeBin = String.raw`C:\Users\tester\AppData\Local\Programs\DeepSeek Harness\resources\runtime\bin`;
		const result = await resolveDeepSeekInstallation({
			platform: "win32",
			env: {
				LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local`,
				DSH_HOME: String.raw`D:\DeepSeekData`,
			},
			homeDirectory: String.raw`C:\Users\tester`,
			exists: available(executable, appAsar, packageManager, runtimeBin),
		});
		expect(result.applicationDirectory).toBe(applicationDirectory);
		expect(result.profileDirectory).toBe(String.raw`D:\DeepSeekData\profiles\desktop`);
		expect(result.entry).toBe(entry);
	});

	it("reports the environment override when a desktop runtime is missing", async () => {
		await expect(
			resolveZCodeInstallation({
				platform: "win32",
				env: { LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local` },
				exists: available(),
			}),
		).rejects.toThrow("SMART_WORKFLOW_ZCODE_RESOURCES");
	});

	it("rejects unsupported desktop platforms", async () => {
		await expect(resolveChromeExecutable({ platform: "linux", env: {}, exists: available() })).rejects.toThrow(
			"只支持 macOS 和 Windows",
		);
	});
});
