import { readFile } from "node:fs/promises";
import type { ResolvedRoute } from "../ocx.ts";

type UnknownRecord = Record<string, unknown>;

export interface ZCodeModelBinding {
	providerId: string;
	providerName?: string;
	modelId: string;
	selector: string;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerRules(config: UnknownRecord): unknown[] {
	const providerConfigRules = config.providerConfigRules;
	if (!isRecord(providerConfigRules) || !Array.isArray(providerConfigRules.providerRules)) return [];
	return providerConfigRules.providerRules;
}

function providerNameFor(config: UnknownRecord, providerId: string): string | undefined {
	const provider = providerRules(config).find(
		(candidate) => isRecord(candidate) && candidate.providerId === providerId,
	);
	return isRecord(provider) && typeof provider.providerName === "string" ? provider.providerName : undefined;
}

function providerMatchesRoute(provider: UnknownRecord, route: ResolvedRoute): boolean {
	if (!route.provider || typeof provider.providerId !== "string") return false;
	if (provider.providerId === route.provider || provider.providerId === `${route.provider}-chat`) return true;
	if (typeof provider.providerName !== "string") return false;
	const normalizedName = provider.providerName.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
	const normalizedRoute = route.provider.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
	return normalizedName.startsWith(normalizedRoute);
}

export function resolveZCodeModelBinding(value: unknown, route: ResolvedRoute): ZCodeModelBinding {
	if (!isRecord(value) || !isRecord(value.config)) throw new Error("ZCode provider_config.json 缺少 config");
	const rules = value.config.modelConfigRules;
	if (!isRecord(rules) || !Array.isArray(rules.providerModelRules)) {
		throw new Error("ZCode provider_config.json 缺少 providerModelRules");
	}

	const candidates = new Set<string>([route.selector]);
	if (route.modelId) candidates.add(route.modelId);
	if (route.provider && route.modelId) candidates.add(`${route.provider}/${route.modelId}`);
	for (const item of rules.providerModelRules) {
		if (!isRecord(item) || typeof item.providerId !== "string" || typeof item.modelId !== "string") continue;
		if (!candidates.has(item.modelId)) continue;
		const enabled = !isRecord(item.config) || item.config.enabled !== false;
		if (!enabled) throw new Error(`ZCode 模型 ${item.providerId}/${item.modelId} 已禁用`);
		const providerName = providerNameFor(value.config, item.providerId);
		return {
			providerId: item.providerId,
			...(providerName ? { providerName } : {}),
			modelId: item.modelId,
			selector: `${item.providerId}/${item.modelId}`,
		};
	}
	if (route.modelId) {
		const provider = providerRules(value.config).find(
			(candidate) => isRecord(candidate) && providerMatchesRoute(candidate, route),
		);
		if (isRecord(provider) && typeof provider.providerId === "string") {
			const providerName = typeof provider.providerName === "string" ? provider.providerName : undefined;
			return {
				providerId: provider.providerId,
				...(providerName ? { providerName } : {}),
				modelId: route.modelId,
				selector: `${provider.providerId}/${route.modelId}`,
			};
		}
	}
	throw new Error(`ZCode 尚未配置 OCX 路由 ${route.selector}`);
}

export function resolveZCodeModelSelector(value: unknown, route: ResolvedRoute): string {
	return resolveZCodeModelBinding(value, route).selector;
}

export async function readZCodeModelBinding(path: string, route: ResolvedRoute): Promise<ZCodeModelBinding> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`无法读取 ZCode 模型配置：${path}`, { cause: error });
	}
	return resolveZCodeModelBinding(value, route);
}

export async function readZCodeModelSelector(path: string, route: ResolvedRoute): Promise<string> {
	return (await readZCodeModelBinding(path, route)).selector;
}
