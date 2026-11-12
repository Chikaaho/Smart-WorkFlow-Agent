import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type DesktopPlatform = "darwin" | "win32";
type PathExists = (path: string) => Promise<boolean>;

export interface DesktopPathLookupOptions {
	platform?: NodeJS.Platform;
	env?: Readonly<Record<string, string | undefined>>;
	homeDirectory?: string;
	exists?: PathExists;
}

export interface ZCodeInstallationPaths {
	resourcesDirectory: string;
	agentExecutable: string;
	builtinProviderConfig: string;
	personalProviderConfig: string;
}

export interface DeepSeekInstallationPaths {
	applicationDirectory: string;
	executable: string;
	resourcesDirectory: string;
	entry: string;
	installationRoot: string;
	profileDirectory: string;
	primaryRuntime: string;
	packageManager: string;
	runtimeBin: string;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function requirePlatform(platform: NodeJS.Platform): DesktopPlatform {
	if (platform === "darwin" || platform === "win32") return platform;
	throw new Error(`当前桌面工作流只支持 macOS 和 Windows，实际平台为 ${platform}`);
}

function readPath(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
	const value = env[key]?.trim();
	return value || undefined;
}

function pathApi(platform: DesktopPlatform): typeof posix {
	return platform === "win32" ? win32 : posix;
}

async function assertPaths(label: string, paths: string[], exists: PathExists, override: string): Promise<void> {
	const missing: string[] = [];
	for (const path of paths) if (!(await exists(path))) missing.push(path);
	if (missing.length === 0) return;
	throw new Error(`${label} 缺少必要文件：${missing.join("、")}。自定义安装位置请设置 ${override}`);
}

export async function resolveChromeExecutable(options: DesktopPathLookupOptions = {}): Promise<string> {
	const platform = requirePlatform(options.platform ?? process.platform);
	const env = options.env ?? process.env;
	const exists = options.exists ?? pathExists;
	const explicit = readPath(env, "SMART_WORKFLOW_CHROME_EXECUTABLE");
	const candidates = explicit
		? [explicit]
		: platform === "darwin"
			? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
			: [
					readPath(env, "LOCALAPPDATA")
						? win32.join(readPath(env, "LOCALAPPDATA")!, "Google", "Chrome", "Application", "chrome.exe")
						: undefined,
					readPath(env, "PROGRAMFILES")
						? win32.join(readPath(env, "PROGRAMFILES")!, "Google", "Chrome", "Application", "chrome.exe")
						: undefined,
					readPath(env, "PROGRAMFILES(X86)")
						? win32.join(readPath(env, "PROGRAMFILES(X86)")!, "Google", "Chrome", "Application", "chrome.exe")
						: undefined,
				].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) if (await exists(candidate)) return candidate;
	throw new Error(
		`找不到 Google Chrome。请安装 Chrome，或设置 SMART_WORKFLOW_CHROME_EXECUTABLE；已检查：${candidates.join("、") || "无可用系统路径"}`,
	);
}

function zcodeResourcesCandidates(
	platform: DesktopPlatform,
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	const explicit = readPath(env, "SMART_WORKFLOW_ZCODE_RESOURCES");
	if (explicit) return [explicit];
	if (platform === "darwin") return ["/Applications/ZCode.app/Contents/Resources"];
	return [
		readPath(env, "LOCALAPPDATA")
			? win32.join(readPath(env, "LOCALAPPDATA")!, "Programs", "ZCode", "resources")
			: undefined,
		readPath(env, "PROGRAMFILES") ? win32.join(readPath(env, "PROGRAMFILES")!, "ZCode", "resources") : undefined,
		readPath(env, "PROGRAMFILES(X86)")
			? win32.join(readPath(env, "PROGRAMFILES(X86)")!, "ZCode", "resources")
			: undefined,
	].filter((candidate): candidate is string => Boolean(candidate));
}

export async function resolveZCodeInstallation(
	options: DesktopPathLookupOptions = {},
): Promise<ZCodeInstallationPaths> {
	const platform = requirePlatform(options.platform ?? process.platform);
	const env = options.env ?? process.env;
	const exists = options.exists ?? pathExists;
	const api = pathApi(platform);
	const personalProviderConfig =
		readPath(env, "SMART_WORKFLOW_ZCODE_PERSONAL_PROVIDER_CONFIG") ??
		api.join(options.homeDirectory ?? homedir(), ".zcode", "v2", "provider_config.json");
	const checked: string[] = [];
	for (const resourcesDirectory of zcodeResourcesCandidates(platform, env)) {
		const agentExecutable = api.join(resourcesDirectory, "glm", "zcode.cjs");
		const builtinProviderConfig = api.join(resourcesDirectory, "config", "provider", "zcode-builtin.json");
		checked.push(resourcesDirectory);
		if ((await exists(agentExecutable)) && (await exists(builtinProviderConfig))) {
			await assertPaths(
				"ZCode 个人模型配置",
				[personalProviderConfig],
				exists,
				"SMART_WORKFLOW_ZCODE_PERSONAL_PROVIDER_CONFIG",
			);
			return { resourcesDirectory, agentExecutable, builtinProviderConfig, personalProviderConfig };
		}
	}
	throw new Error(
		`找不到 ZCode 协议运行时。请安装 ZCode，或设置 SMART_WORKFLOW_ZCODE_RESOURCES；已检查：${checked.join("、") || "无可用系统路径"}`,
	);
}

function deepSeekApplicationCandidates(
	platform: DesktopPlatform,
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	const explicit = readPath(env, "SMART_WORKFLOW_DEEPSEEK_INSTALL_DIR");
	if (explicit) return [explicit];
	if (platform === "darwin") return ["/Applications/DeepSeek Harness.app"];
	return [
		readPath(env, "LOCALAPPDATA")
			? win32.join(readPath(env, "LOCALAPPDATA")!, "Programs", "DeepSeek Harness")
			: undefined,
		readPath(env, "PROGRAMFILES") ? win32.join(readPath(env, "PROGRAMFILES")!, "DeepSeek Harness") : undefined,
		readPath(env, "PROGRAMFILES(X86)")
			? win32.join(readPath(env, "PROGRAMFILES(X86)")!, "DeepSeek Harness")
			: undefined,
	].filter((candidate): candidate is string => Boolean(candidate));
}

function deepSeekLayout(
	applicationDirectory: string,
	platform: DesktopPlatform,
	env: Readonly<Record<string, string | undefined>>,
	homeDirectory: string,
): DeepSeekInstallationPaths {
	const api = pathApi(platform);
	const resourcesDirectory =
		readPath(env, "SMART_WORKFLOW_DEEPSEEK_RESOURCES") ??
		(platform === "darwin"
			? api.join(applicationDirectory, "Contents", "Resources")
			: api.join(applicationDirectory, "resources"));
	const executable =
		readPath(env, "SMART_WORKFLOW_DEEPSEEK_EXECUTABLE") ??
		(platform === "darwin"
			? api.join(applicationDirectory, "Contents", "MacOS", "DeepSeek Harness")
			: api.join(applicationDirectory, "DeepSeek Harness.exe"));
	const installationRoot = api.join(resourcesDirectory, "app.asar", "dsh");
	const primaryRuntime = api.join(resourcesDirectory, "runtime", "primary-runtime");
	const dshHome = readPath(env, "DSH_HOME") ?? api.join(homeDirectory, ".dsh");
	return {
		applicationDirectory,
		executable,
		resourcesDirectory,
		entry: api.join(installationRoot, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js"),
		installationRoot,
		profileDirectory: api.join(dshHome, "profiles", "desktop"),
		primaryRuntime,
		packageManager: api.join(primaryRuntime, "dependencies", "pnpm", "bin", "pnpm.mjs"),
		runtimeBin: api.join(resourcesDirectory, "runtime", "bin"),
	};
}

export async function resolveDeepSeekInstallation(
	options: DesktopPathLookupOptions = {},
): Promise<DeepSeekInstallationPaths> {
	const platform = requirePlatform(options.platform ?? process.platform);
	const env = options.env ?? process.env;
	const exists = options.exists ?? pathExists;
	const checked: string[] = [];
	for (const applicationDirectory of deepSeekApplicationCandidates(platform, env)) {
		const layout = deepSeekLayout(applicationDirectory, platform, env, options.homeDirectory ?? homedir());
		checked.push(applicationDirectory);
		const api = pathApi(platform);
		const required = [
			layout.executable,
			api.join(layout.resourcesDirectory, "app.asar"),
			layout.packageManager,
			layout.runtimeBin,
		];
		if ((await Promise.all(required.map(async (path) => await exists(path)))).every(Boolean)) return layout;
	}
	throw new Error(
		`找不到 DeepSeek Harness Desktop Host。请安装 DeepSeek Harness，或设置 SMART_WORKFLOW_DEEPSEEK_INSTALL_DIR；已检查：${checked.join("、") || "无可用系统路径"}`,
	);
}
