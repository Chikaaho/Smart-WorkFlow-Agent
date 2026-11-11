import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { BrowserCommandRequest, VisibleBrowserProvider } from "./cdp-browser.ts";
import type { ZCodeDesktopDriver, ZCodeDesktopRequest, ZCodeDesktopResult } from "./zcode.ts";

type UnknownRecord = Record<string, unknown>;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export interface ZCodeProtocolModel {
	providerId: string;
	modelId: string;
	reasoningLevel?: string;
}

export interface ZCodePreparedSession {
	sessionId: string;
	workspacePath: string;
	model: ZCodeProtocolModel;
}

export interface ZCodeProtocolClientOptions {
	executable: string;
	builtinProviderConfig: string;
	personalProviderConfig: string;
	workspacePath: string;
	browser: VisibleBrowserProvider;
	requestTimeoutMs?: number;
	toolAllowlist?: string[];
	env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value ? value : undefined;
}

function collectStrings(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, output);
		return;
	}
	if (!isRecord(value)) return;
	for (const item of Object.values(value)) collectStrings(item, output);
}

function markerLine(value: unknown, marker: string): string | undefined {
	const strings: string[] = [];
	collectStrings(value, strings);
	for (const text of strings.toReversed()) {
		const line = text.split(/\r?\n/u).find((candidate) => candidate.trim().startsWith(marker));
		if (line) return line.trim();
	}
	return undefined;
}

export class ZCodeProtocolClient {
	readonly options: ZCodeProtocolClientOptions;
	#child?: ChildProcessWithoutNullStreams;
	#nextId = 0;
	#pending = new Map<string, PendingRequest>();
	#stderr = "";

	constructor(options: ZCodeProtocolClientOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.#child) return;
		const child = spawn(
			process.execPath,
			[this.options.executable, "app-server", "--surface", "desktop", "--cwd", this.options.workspacePath],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					...this.options.env,
					ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: this.options.builtinProviderConfig,
					ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: this.options.personalProviderConfig,
				},
			},
		);
		this.#child = child;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
		});
		child.on("error", (error) => this.#rejectPending(error));
		child.on("close", (code) => {
			this.#rejectPending(new Error(this.#stderr.trim() || `ZCode app-server 退出码 ${code}`));
			this.#child = undefined;
		});
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => void this.#onLine(line));
		await this.request("runtime/capabilities", {});
	}

	async prepare(
		model: ZCodeProtocolModel,
		sessionId = `sess_workflow_${randomUUID()}`,
	): Promise<ZCodePreparedSession> {
		await this.start();
		const reasoningLevel = model.reasoningLevel ?? "max";
		await this.request("session/create", {
			sessionId,
			workspace: {
				workspacePath: this.options.workspacePath,
				workspaceKey: this.options.workspacePath,
			},
			mode: "guarded",
			model: {
				providerId: model.providerId,
				modelId: model.modelId,
				options: { reasoningLevel },
			},
			thoughtLevel: reasoningLevel,
			persistence: "immediate",
			titleGenerationEnabled: false,
			...(this.options.toolAllowlist ? { toolAllowlist: this.options.toolAllowlist } : {}),
		});
		return { sessionId, workspacePath: this.options.workspacePath, model };
	}

	async resume(sessionId: string, model: ZCodeProtocolModel): Promise<ZCodePreparedSession> {
		await this.start();
		await this.request("session/resume", {
			sessionId,
			workspace: {
				workspacePath: this.options.workspacePath,
				workspaceKey: this.options.workspacePath,
			},
			thoughtLevel: model.reasoningLevel ?? "max",
			...(this.options.toolAllowlist ? { toolAllowlist: this.options.toolAllowlist } : {}),
		});
		return { sessionId, workspacePath: this.options.workspacePath, model };
	}

	async sendAndWait(
		session: ZCodePreparedSession,
		input: { prompt: string; marker: string; timeoutMs?: number },
	): Promise<string> {
		const timeoutMs = input.timeoutMs ?? 300_000;
		const inputId = `input_${randomUUID()}`;
		await this.request("session/send", {
			sessionId: session.sessionId,
			inputId,
			queryId: inputId,
			content: input.prompt,
		});
		const timeoutAt = Date.now() + timeoutMs;
		while (Date.now() < timeoutAt) {
			const messages = await this.request("session/messages", { sessionId: session.sessionId });
			const output = markerLine(messages, input.marker);
			if (output) return output;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		await this.stop(session.sessionId);
		throw new Error(`等待 ZCode 协议结果超时：${input.marker}`);
	}

	async stop(sessionId: string): Promise<void> {
		if (!this.#child) return;
		await this.request("session/stop", { sessionId });
	}

	async close(): Promise<void> {
		if (this.#child && this.#child.exitCode === null) this.#child.kill("SIGTERM");
		this.#child = undefined;
		this.#rejectPending(new Error("ZCode 协议客户端已关闭"));
		await this.options.browser.close();
	}

	async request(method: string, params: UnknownRecord): Promise<unknown> {
		if (!this.#child) {
			if (method === "runtime/capabilities") throw new Error("ZCode app-server 尚未启动");
			await this.start();
		}
		const child = this.#child;
		if (!child) throw new Error("ZCode app-server 尚未启动");
		this.#nextId += 1;
		const id = `pi-${this.#nextId}`;
		const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`ZCode 协议请求超时：${method}`));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	async #onLine(line: string): Promise<void> {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(value)) return;
		const id = readString(value, "id");
		if (!id) return;
		const pending = this.#pending.get(id);
		if (pending) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			if (isRecord(value.error)) {
				pending.reject(new Error(readString(value.error, "message") ?? "ZCode 协议请求失败"));
			} else {
				pending.resolve(value.result);
			}
			return;
		}
		const method = readString(value, "method");
		if (!method) return;
		try {
			const result = await this.#handleServerRequest(method, isRecord(value.params) ? value.params : {});
			this.#write({ id, result });
		} catch (error) {
			this.#write({
				id,
				error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	async #handleServerRequest(method: string, params: UnknownRecord): Promise<unknown> {
		switch (method) {
			case "session/requestRuntimePreferences":
				return {
					nativeSearchEnhancementsEnabled: false,
					toolSearchMode: "off",
					subagentRuntimeConfigEnabled: false,
					memoryEnabled: false,
					askUserQuestionAutoResolutionEnabled: true,
					modelContextBudgetStrategy: "preflight-v1",
				};
			case "interaction/browserList":
				return await this.options.browser.list();
			case "interaction/browserExecute": {
				if (!isRecord(params.command)) throw new Error("ZCode 浏览器请求缺少 command");
				const requestId = readString(params, "requestId");
				if (!requestId) throw new Error("ZCode 浏览器请求缺少 requestId");
				const request: BrowserCommandRequest = { requestId, command: params.command };
				return await this.options.browser.execute(request);
			}
			default:
				throw new Error(`Pi 尚未实现 ZCode 回调 ${method}`);
		}
	}

	#write(value: UnknownRecord): void {
		this.#child?.stdin.write(`${JSON.stringify(value)}\n`);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

export class ZCodeProtocolDriver implements ZCodeDesktopDriver {
	readonly client: ZCodeProtocolClient;
	#sessions = new Map<string, ZCodePreparedSession>();

	constructor(client: ZCodeProtocolClient) {
		this.client = client;
	}

	async prepare(request: Pick<ZCodeDesktopRequest, "workspacePath" | "model">): Promise<{ sessionId: string }> {
		if (request.workspacePath !== this.client.options.workspacePath) {
			throw new Error("ZCode 协议客户端绑定了其他 Workspace");
		}
		const session = await this.client.prepare({
			providerId: request.model.providerId,
			modelId: request.model.modelId,
			reasoningLevel: "max",
		});
		this.#sessions.set(session.sessionId, session);
		return { sessionId: session.sessionId };
	}

	async run(request: ZCodeDesktopRequest & { sessionId: string }): Promise<ZCodeDesktopResult> {
		const session = this.#sessions.get(request.sessionId);
		if (!session) throw new Error(`ZCode 会话尚未准备：${request.sessionId}`);
		const output = await this.client.sendAndWait(session, {
			prompt: request.prompt,
			marker: request.resultMarker,
			...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
		});
		return { marker: request.resultMarker, output, workspacePath: request.workspacePath };
	}

	async release(sessionId: string): Promise<void> {
		await this.client.stop(sessionId);
		this.#sessions.delete(sessionId);
	}

	async pause(sessionId: string): Promise<void> {
		await this.client.stop(sessionId);
	}

	async cancel(sessionId: string): Promise<void> {
		await this.client.stop(sessionId);
		this.#sessions.delete(sessionId);
	}
}
