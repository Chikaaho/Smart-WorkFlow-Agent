import { describe, expect, it } from "vitest";
import {
	DEEPSEEK_FULL_ACCESS_PRESET,
	DeepSeekDesktopHostClient,
	type DeepSeekDesktopHostOptions,
} from "../src/desktop/deepseek-protocol.ts";
import {
	ZCODE_FULL_CONTROL_MODE,
	ZCodeProtocolClient,
	type ZCodeProtocolClientOptions,
} from "../src/desktop/zcode-protocol.ts";

type UnknownRecord = Record<string, unknown>;

const zcodeOptions: ZCodeProtocolClientOptions = {
	executable: "/unused/zcode.cjs",
	builtinProviderConfig: "/unused/builtin-provider.json",
	personalProviderConfig: "/unused/personal-provider.json",
	workspacePath: "/workspace",
	browser: {
		async list() {
			return {};
		},
		async execute() {
			return { ok: true };
		},
		async close() {},
	},
};

class FakeZCodeProtocolClient extends ZCodeProtocolClient {
	readonly requests: Array<{ method: string; params: UnknownRecord }> = [];

	override async start(): Promise<void> {}

	override async request(method: string, params: UnknownRecord): Promise<unknown> {
		this.requests.push({ method, params });
		return {};
	}
}

const deepSeekOptions: DeepSeekDesktopHostOptions = {
	executable: "/unused/deepseek",
	entry: "/unused/entry.cjs",
	installationRoot: "/unused",
	profileDirectory: "/unused/profile",
	primaryRuntime: "/unused/runtime",
	packageManager: "/unused/package-manager",
	runtimeBin: "/unused/bin",
};

class FakeDeepSeekDesktopHostClient extends DeepSeekDesktopHostClient {
	readonly requests: Array<{ method: string; args: UnknownRecord }> = [];
	permissionPreset = DEEPSEEK_FULL_ACCESS_PRESET;

	override async start(): Promise<void> {}

	override async request(method: string, args: UnknownRecord): Promise<unknown> {
		this.requests.push({ method, args });
		switch (method) {
			case "session/create":
				return { sessionId: "deepseek-session-1" };
			case "commands/execute":
				return { result: { kind: "success", text: `preset ${this.permissionPreset}` } };
			case "session/projections":
				return { values: { permissions: { currentValue: this.permissionPreset } } };
			case "session/selectModel":
				return {
					selected: {
						provider: "deepseek-official",
						model: "deepseek-flash",
						reasoningEffort: "high",
					},
				};
			default:
				throw new Error(`未处理测试请求：${method}`);
		}
	}
}

describe("desktop session permissions", () => {
	it("creates ZCode sessions in full-control mode", async () => {
		const client = new FakeZCodeProtocolClient(zcodeOptions);
		await client.prepare({ providerId: "provider", modelId: "model" }, "zcode-session-1");
		const create = client.requests.find((request) => request.method === "session/create");
		expect(create?.params.mode).toBe(ZCODE_FULL_CONTROL_MODE);
	});

	it("switches resumed ZCode sessions back to full-control mode", async () => {
		const client = new FakeZCodeProtocolClient(zcodeOptions);
		await client.resume("zcode-session-1", { providerId: "provider", modelId: "model" });
		expect(client.requests.at(-1)).toEqual({
			method: "session/setMode",
			params: { sessionId: "zcode-session-1", mode: ZCODE_FULL_CONTROL_MODE },
		});
	});

	it("enables and reads back full access before selecting a DeepSeek model", async () => {
		const client = new FakeDeepSeekDesktopHostClient(deepSeekOptions);
		await client.prepare("/workspace", {
			provider: "deepseek-official",
			model: "deepseek-flash",
			reasoningEffort: "high",
		});
		expect(client.requests.map((request) => request.method)).toEqual([
			"session/create",
			"commands/execute",
			"session/projections",
			"session/selectModel",
		]);
		expect(client.requests[1]?.args).toEqual({
			agentId: "deepseek-session-1",
			line: `/permission ${DEEPSEEK_FULL_ACCESS_PRESET}`,
			submittedAttachments: [],
		});
	});

	it("rejects a DeepSeek session when full-access readback differs", async () => {
		const client = new FakeDeepSeekDesktopHostClient(deepSeekOptions);
		client.permissionPreset = "default";
		await expect(
			client.prepare("/workspace", {
				provider: "deepseek-official",
				model: "deepseek-flash",
				reasoningEffort: "high",
			}),
		).rejects.toThrow("完全权限回读不一致");
	});
});
