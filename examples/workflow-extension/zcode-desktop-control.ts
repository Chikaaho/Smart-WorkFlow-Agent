import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DRIVER_PATH = fileURLToPath(new URL("./macos/zcode-desktop-control.js", import.meta.url));
const PERMISSION_DRIVER_PATH = fileURLToPath(
	new URL("./macos/zcode-browser-permission.js", import.meta.url),
);
const MODEL_DRIVER_PATH = fileURLToPath(new URL("./macos/zcode-model-control.js", import.meta.url));
const DEFAULT_PAGE_URL = "http://127.0.0.1:4173/p0-filter-pagination-demo.html";
const DEFAULT_TIMEOUT_MS = 300_000;

const RUN_PARAMS = Type.Object({
	workspacePath: Type.String({ description: "ZCode 项目的本地目录绝对路径" }),
	prompt: Type.String({ description: "发给 ZCode 会话的任务说明" }),
	resultMarker: Type.String({ description: "用于回读最终结果的唯一文本标记" }),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 600_000 })),
});

interface DesktopRunResult {
	marker: string;
	output: string;
	workspacePath: string;
}

interface ModelSwitchResult {
	providerName: string;
	modelName: string;
	selectedLabel: string;
}

function parseDriverResult(stdout: string): DesktopRunResult {
	const parsed: unknown = JSON.parse(stdout.trim());
	if (!parsed || typeof parsed !== "object") throw new Error("ZCode 桌面驱动返回了无效结果");
	const result = parsed as Partial<DesktopRunResult>;
	if (
		typeof result.marker !== "string" ||
		typeof result.output !== "string" ||
		typeof result.workspacePath !== "string"
	) {
		throw new Error("ZCode 桌面驱动缺少必要字段");
	}
	return result as DesktopRunResult;
}

function parseModelSwitchResult(stdout: string): ModelSwitchResult {
	if (!stdout.trim()) throw new Error("ZCode 模型控制没有返回结果");
	const parsed: unknown = JSON.parse(stdout.trim());
	if (!parsed || typeof parsed !== "object") throw new Error("ZCode 模型控制返回了无效结果");
	const result = parsed as Partial<ModelSwitchResult>;
	if (
		typeof result.providerName !== "string" ||
		typeof result.modelName !== "string" ||
		typeof result.selectedLabel !== "string" ||
		!result.selectedLabel.includes(result.providerName) ||
		!result.selectedLabel.includes(result.modelName)
	) {
		throw new Error("ZCode 模型控制未能回读目标模型");
	}
	return result as ModelSwitchResult;
}

function formatDriverFailure(output: string): string {
	if (/(-25211|不允许辅助访问|not allowed assistive access)/iu.test(output)) {
		return [
			"macOS 已拒绝 Pi 的辅助功能访问，任务尚未送入 ZCode 会话。",
			"请在“系统设置 → 隐私与安全性 → 辅助功能”中允许运行 Pi 的终端应用，重新启动 Pi 后再执行 /harness-p0-zcode。",
		].join("\n");
	}
	return output || "ZCode 桌面驱动执行失败";
}

async function runZCodeDesktop(
	pi: ExtensionAPI,
	params: {
		workspacePath: string;
		prompt: string;
		resultMarker: string;
		timeoutMs?: number;
	},
): Promise<DesktopRunResult> {
	if (process.platform !== "darwin") throw new Error("ZCode 桌面驱动目前只支持 macOS");

	const opened = await pi.exec("/usr/bin/open", ["-a", "ZCode", params.workspacePath], { timeout: 10_000 });
	if (opened.code !== 0) {
		throw new Error(opened.stderr.trim() || "无法把项目交给 ZCode");
	}

	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const result = await pi.exec(
		"/usr/bin/osascript",
		[
			"-l",
			"JavaScript",
			DRIVER_PATH,
			params.workspacePath,
			params.prompt,
			params.resultMarker,
			String(timeoutMs),
		],
		{ timeout: timeoutMs + 15_000 },
	);
	if (result.code !== 0) {
		throw new Error(formatDriverFailure(result.stderr.trim() || result.stdout.trim()));
	}
	return parseDriverResult(result.stdout);
}

async function switchZCodeModel(
	pi: ExtensionAPI,
	providerName: string,
	modelName: string,
): Promise<ModelSwitchResult> {
	const result = await pi.exec(
		"/usr/bin/osascript",
		["-l", "JavaScript", MODEL_DRIVER_PATH, providerName, modelName, "60000"],
		{ timeout: 70_000 },
	);
	if (result.code !== 0) {
		throw new Error(formatDriverFailure(result.stderr.trim() || result.stdout.trim()));
	}
	return parseModelSwitchResult(result.stdout);
}

function buildP0Prompt(marker: string): string {
	return [
		"使用 ZCode 内置 Browser Use，在宿主可见浏览器中完成下面的验证。",
		`打开 ${DEFAULT_PAGE_URL}，把“部门”筛选为“财务部”，再点击“下一页”。`,
		"读取筛选条件、当前页码和表格内全部三条编号。",
		"不能用 curl、fetch、读取 HTML 源码或其他浏览器代替实际页面操作。",
		`完成后只输出一行：${marker} {\"department\":\"财务部\",\"page\":\"2 / 2\",\"ids\":[\"AP-110\",\"AP-113\",\"AP-116\"]}`,
	].join("\n");
}

async function runP0Command(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const marker = `P0_ZCODE_${Date.now()}`;
	ctx.ui.setStatus("zcode-p0", "ZCode 正在执行筛选后翻页验证");
	ctx.ui.notify("任务已交给 ZCode，会由 ZCode 操作宿主浏览器。", "info");
	try {
		const result = await runZCodeDesktop(pi, {
			workspacePath: ctx.cwd,
			prompt: buildP0Prompt(marker),
			resultMarker: marker,
		});
		ctx.ui.notify(`ZCode 回读结果：${result.output}`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		ctx.ui.setStatus("zcode-p0", undefined);
	}
}

export default function zcodeDesktopControl(pi: ExtensionAPI) {
	pi.registerTool({
		name: "zcode_desktop_run",
		label: "Run ZCode Desktop",
		description: "把任务送入本机 ZCode 桌面会话，并从同一窗口回读带标记的最终结果。",
		promptSnippet: "让本机 ZCode 桌面应用执行需要其宿主能力的任务",
		promptGuidelines: ["浏览器操作必须由 ZCode 自己完成时，使用 zcode_desktop_run。"],
		parameters: RUN_PARAMS,
		async execute(_toolCallId, params) {
			const result = await runZCodeDesktop(pi, params);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
			};
		},
	});

	pi.registerCommand("harness-p0-zcode", {
		description: "让 ZCode 在宿主浏览器中验证筛选后翻页",
		handler: async (_args, ctx) => runP0Command(pi, ctx),
	});

	pi.registerCommand("harness-zcode-approve-browser", {
		description: "批准 ZCode 当前等待的 Browser Use 权限",
		handler: async (_args, ctx) => {
			const result = await pi.exec(
				"/usr/bin/osascript",
				["-l", "JavaScript", PERMISSION_DRIVER_PATH],
				{ timeout: 60_000 },
			);
			if (result.code !== 0) {
				ctx.ui.notify(formatDriverFailure(result.stderr.trim() || result.stdout.trim()), "error");
				return;
			}
			ctx.ui.notify(result.stdout.trim() || "ZCode Browser Use 权限已确认。", "info");
		},
	});

	pi.registerCommand("harness-zcode-model-probe", {
		description: "在新 ZCode 会话中绑定指定模型并回读结果",
		handler: async (args, ctx) => {
			const separator = args.indexOf("/");
			if (separator < 1 || separator === args.length - 1) {
				ctx.ui.notify("用法：/harness-zcode-model-probe <服务商>/<模型>", "error");
				return;
			}
			const providerName = args.slice(0, separator).trim();
			const modelName = args.slice(separator + 1).trim();
			const marker = `MODEL_PROBE_${Date.now()}`;
			try {
				const selected = await switchZCodeModel(pi, providerName, modelName);
				const result = await runZCodeDesktop(pi, {
					workspacePath: ctx.cwd,
					prompt: `只输出一行：${marker} {"modelRoute":${JSON.stringify(selected.selectedLabel)}}`,
					resultMarker: marker,
				});
				ctx.ui.notify(`ZCode 模型探针结果：${result.output}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("harness-zcode-model-switch", {
		description: "切换并回读 ZCode 桌面模型选择器",
		handler: async (args, ctx) => {
			const separator = args.indexOf("/");
			if (separator < 1 || separator === args.length - 1) {
				ctx.ui.notify("用法：/harness-zcode-model-switch <服务商>/<模型>", "error");
				return;
			}
			const providerName = args.slice(0, separator).trim();
			const modelName = args.slice(separator + 1).trim();
			try {
				const selected = await switchZCodeModel(pi, providerName, modelName);
				ctx.ui.notify(`ZCode 模型已切换：${selected.selectedLabel}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
