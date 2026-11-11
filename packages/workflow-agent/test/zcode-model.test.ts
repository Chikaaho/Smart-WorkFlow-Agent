import { describe, expect, it } from "vitest";
import { resolveZCodeModelBinding, resolveZCodeModelSelector } from "../src/desktop/zcode-model.ts";

describe("resolveZCodeModelSelector", () => {
	it("maps the OCX model identity to ZCode's configured provider", () => {
		const selector = resolveZCodeModelSelector(
			{
				config: {
					providerConfigRules: {
						providerRules: [{ providerId: "new-provider", providerName: "CommandCode(Chat)" }],
					},
					modelConfigRules: {
						providerModelRules: [
							{
								providerId: "new-provider",
								modelId: "deepseek/deepseek-v4.1-flash",
								config: { enabled: true },
							},
						],
					},
				},
			},
			{
				requested: "command-code/deepseek-deepseek-v4.1-flash",
				selector: "command-code/deepseek-deepseek-v4.1-flash",
				kind: "model",
				provider: "command-code",
				modelId: "deepseek/deepseek-v4.1-flash",
			},
		);
		expect(selector).toBe("new-provider/deepseek/deepseek-v4.1-flash");
	});

	it("returns the provider identity required by ZCode session/create", () => {
		const binding = resolveZCodeModelBinding(
			{
				config: {
					providerConfigRules: {
						providerRules: [{ providerId: "opencode-go-chat", providerName: "OpenCode(Chat)" }],
					},
					modelConfigRules: {
						providerModelRules: [
							{ providerId: "opencode-go-chat", modelId: "deepseek-v4.1-flash", config: { enabled: true } },
						],
					},
				},
			},
			{
				requested: "opencode/deepseek-v4.1-flash",
				selector: "opencode/deepseek-v4.1-flash",
				kind: "model",
				provider: "opencode",
				modelId: "deepseek-v4.1-flash",
			},
		);
		expect(binding).toEqual({
			providerId: "opencode-go-chat",
			providerName: "OpenCode(Chat)",
			modelId: "deepseek-v4.1-flash",
			selector: "opencode-go-chat/deepseek-v4.1-flash",
		});
	});

	it("keeps OpenCode Chat and CommandCode Chat as distinct selectable routes", () => {
		const config = {
			config: {
				providerConfigRules: {
					providerRules: [
						{ providerId: "opencode-go-chat", providerName: "OpenCode(Chat)" },
						{ providerId: "new-provider", providerName: "CommandCode(Chat)" },
					],
				},
				modelConfigRules: {
					providerModelRules: [
						{
							providerId: "opencode-go-chat",
							modelId: "deepseek-v4.1-flash",
							config: { enabled: true },
						},
						{
							providerId: "new-provider",
							modelId: "deepseek/deepseek-v4.1-flash",
							config: { enabled: true },
						},
					],
				},
			},
		};
		const openCode = resolveZCodeModelBinding(config, {
			requested: "opencode-go/deepseek-v4.1-flash",
			selector: "opencode-go/deepseek-v4.1-flash",
			kind: "model",
			provider: "opencode-go",
			modelId: "deepseek-v4.1-flash",
		});
		const commandCode = resolveZCodeModelBinding(config, {
			requested: "command-code/deepseek-deepseek-v4.1-flash",
			selector: "command-code/deepseek-deepseek-v4.1-flash",
			kind: "model",
			provider: "command-code",
			modelId: "deepseek/deepseek-v4.1-flash",
		});
		expect(openCode).toMatchObject({ providerId: "opencode-go-chat", providerName: "OpenCode(Chat)" });
		expect(commandCode).toMatchObject({ providerId: "new-provider", providerName: "CommandCode(Chat)" });
	});
});
