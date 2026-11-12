import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
	DeepSeekDesktopDriver,
	DeepSeekDesktopRequest,
	DeepSeekDesktopResult,
	DeepSeekModelBinding,
} from "./deepseek.ts";

type UnknownRecord = Record<string, unknown>;

export const DEEPSEEK_FULL_ACCESS_PRESET = "danger-full-access";

export interface DeepSeekDesktopHostOptions {
	executable: string;
	entry: string;
	installationRoot: string;
	profileDirectory: string;
	primaryRuntime: string;
	packageManager: string;
	runtimeBin: string;
	env?: NodeJS.ProcessEnv;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export interface DeepSeekPreparedSession {
	sessionId: string;
	workspacePath: string;
	model: DeepSeekModelBinding;
}

interface ReadyMessage extends UnknownRecord {
	type: "ready";
	url: string;
}

interface WaitResult extends UnknownRecord {
	reason: "idle" | "input-required" | "timeout";
	output: UnknownRecord;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value ? value : undefined;
}

function isReadyMessage(value: unknown): value is ReadyMessage {
	return isRecord(value) && value.type === "ready" && typeof value.url === "string";
}

function isWaitResult(value: unknown): value is WaitResult {
	return (
		isRecord(value) &&
		(value.reason === "idle" || value.reason === "input-required" || value.reason === "timeout") &&
		isRecord(value.output)
	);
}

function assistantContent(records: unknown): UnknownRecord[] {
	if (!Array.isArray(records)) return [];
	const content: UnknownRecord[] = [];
	for (const record of records) {
		if (!isRecord(record) || !isRecord(record.event) || !isRecord(record.event.data)) continue;
		const message = record.event.data.message;
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const item of message.content) if (isRecord(item)) content.push(item);
	}
	return content;
}

function resultLine(output: UnknownRecord, marker: string): string | undefined {
	const records = output.records;
	for (const item of assistantContent(records)) {
		if (item.type !== "text" || typeof item.text !== "string") continue;
		const line = item.text.split(/\r?\n/u).find((candidate) => candidate.trim().startsWith(marker));
		if (line) return line.trim();
	}
	return undefined;
}

function toolNames(output: UnknownRecord): string[] {
	const names: string[] = [];
	for (const item of assistantContent(output.records)) {
		if (item.type !== "tool-call" || typeof item.name !== "string" || names.includes(item.name)) continue;
		names.push(item.name);
	}
	return names;
}

export class DeepSeekDesktopHostClient {
	readonly options: DeepSeekDesktopHostOptions;
	#child?: ChildProcess;
	#baseUrl?: URL;
	#cookie?: string;
	#stderr = "";

	constructor(options: DeepSeekDesktopHostOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.#child) return;
		const child = spawn(
			this.options.executable,
			[
				"--expose-internals",
				this.options.entry,
				this.options.installationRoot,
				this.options.profileDirectory,
				this.options.primaryRuntime,
				this.options.packageManager,
				this.options.runtimeBin,
			],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: "1" },
			},
		);
		this.#child = child;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
		});
		const ready = await this.#waitForReady(child);
		const authenticatedUrl = new URL(ready.url);
		const response = await fetch(authenticatedUrl, { redirect: "manual" });
		const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie || response.status !== 303) {
			await this.close();
			throw new Error(`DeepSeek Desktop Host 认证失败：HTTP ${response.status}`);
		}
		this.#baseUrl = authenticatedUrl;
		this.#cookie = cookie;
	}

	async prepare(
		workspacePath: string,
		model: DeepSeekModelBinding,
		sessionId = `session-workflow-${randomUUID()}`,
	): Promise<DeepSeekPreparedSession> {
		await this.start();
		const created = await this.request("session/create", {
			request: { cwd: workspacePath, sessionId, agentPreset: "standard" },
		});
		const actualSessionId = isRecord(created) ? readString(created, "sessionId") : undefined;
		if (!actualSessionId) throw new Error("DeepSeek Harness 建会话结果缺少 sessionId");
		const permissionCommand = await this.request("commands/execute", {
			agentId: actualSessionId,
			line: `/permission ${DEEPSEEK_FULL_ACCESS_PRESET}`,
			submittedAttachments: [],
		});
		const commandResult =
			isRecord(permissionCommand) && isRecord(permissionCommand.result) ? permissionCommand.result : undefined;
		if (!commandResult || commandResult.kind !== "success") {
			throw new Error("DeepSeek Harness 没有启用完全权限");
		}
		const projections = await this.request("session/projections", {
			request: { sessionId: actualSessionId },
		});
		const values = isRecord(projections) && isRecord(projections.values) ? projections.values : undefined;
		const permissions = values && isRecord(values.permissions) ? values.permissions : undefined;
		if (!permissions || permissions.currentValue !== DEEPSEEK_FULL_ACCESS_PRESET) {
			throw new Error("DeepSeek Harness 完全权限回读不一致");
		}
		const selected = await this.request("session/selectModel", {
			request: { sessionId: actualSessionId, ...model },
		});
		const actual = isRecord(selected) && isRecord(selected.selected) ? selected.selected : undefined;
		if (
			!actual ||
			actual.provider !== model.provider ||
			actual.model !== model.model ||
			actual.reasoningEffort !== model.reasoningEffort
		) {
			throw new Error("DeepSeek Harness 没有回读派单指定的模型");
		}
		return { sessionId: actualSessionId, workspacePath, model: { ...model } };
	}

	async sendAndWait(
		session: DeepSeekPreparedSession,
		input: { prompt: string; marker: string; timeoutMs?: number },
	): Promise<{ output: string; toolNames: string[] }> {
		await this.request("session/prompt", {
			request: {
				requestId: `request-${randomUUID()}`,
				sessionId: session.sessionId,
				mode: "queue",
				content: [{ type: "text", text: input.prompt }],
			},
		});
		const wait = await this.request(
			"session/wait",
			{
				request: {
					sessionId: session.sessionId,
					timeoutMs: input.timeoutMs ?? 300_000,
					maxMessages: 100,
				},
			},
			(input.timeoutMs ?? 300_000) + 10_000,
		);
		if (!isWaitResult(wait)) throw new Error("DeepSeek Harness 等待结果格式无效");
		if (wait.reason !== "idle") {
			await this.cancel(session.sessionId);
			throw new Error(
				wait.reason === "input-required"
					? "DeepSeek Harness 等待用户输入，任务尚未完成"
					: `等待 DeepSeek Harness 结果超时：${input.marker}`,
			);
		}
		const output = resultLine(wait.output, input.marker);
		if (!output) throw new Error(`DeepSeek Harness 没有返回结果标记：${input.marker}`);
		return { output, toolNames: toolNames(wait.output) };
	}

	async cancel(sessionId: string): Promise<void> {
		if (!this.#child) return;
		await this.request("session/cancel", { request: { sessionId } });
	}

	async close(): Promise<void> {
		const child = this.#child;
		this.#child = undefined;
		this.#baseUrl = undefined;
		this.#cookie = undefined;
		if (!child || child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				resolve();
			}, 10_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.send?.({ type: "shutdown" });
		});
	}

	async request(
		method: string,
		args: UnknownRecord,
		timeoutMs = this.options.requestTimeoutMs ?? 30_000,
	): Promise<unknown> {
		if (!this.#child) await this.start();
		if (!this.#baseUrl || !this.#cookie) throw new Error("DeepSeek Desktop Host 尚未认证");
		const rpcId = randomUUID();
		const response = await fetch(new URL(`/api/${method}`, this.#baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json", cookie: this.#cookie },
			body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		let value: unknown;
		try {
			value = await response.json();
		} catch (error) {
			throw new Error(`DeepSeek RPC ${method} 返回了无效 JSON`, { cause: error });
		}
		if (!response.ok || !isRecord(value) || !isRecord(value.result)) {
			throw new Error(`DeepSeek RPC ${method} 失败：HTTP ${response.status}`);
		}
		if (value.rpcId !== rpcId) throw new Error(`DeepSeek RPC ${method} 的 rpcId 不匹配`);
		if (value.result.ok !== true) {
			const error = isRecord(value.result.error) ? readString(value.result.error, "message") : undefined;
			throw new Error(error ?? `DeepSeek RPC ${method} 被拒绝`);
		}
		return value.result.value;
	}

	async #waitForReady(child: ChildProcess): Promise<ReadyMessage> {
		const timeoutMs = this.options.startupTimeoutMs ?? 60_000;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(this.#stderr.trim() || "DeepSeek Desktop Host 启动超时"));
			}, timeoutMs);
			const fail = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			child.on("message", (message: unknown) => {
				if (isReadyMessage(message)) {
					clearTimeout(timer);
					resolve(message);
					return;
				}
				if (isRecord(message) && message.type === "fatal") {
					fail(new Error(readString(message, "message") ?? "DeepSeek Desktop Host 启动失败"));
				}
			});
			child.once("error", fail);
			child.once("exit", (code) => fail(new Error(this.#stderr.trim() || `DeepSeek Desktop Host 退出码 ${code}`)));
		});
	}
}

export class DeepSeekProtocolDriver implements DeepSeekDesktopDriver {
	readonly client: DeepSeekDesktopHostClient;
	#sessions = new Map<string, DeepSeekPreparedSession>();

	constructor(client: DeepSeekDesktopHostClient) {
		this.client = client;
	}

	async prepare(request: Pick<DeepSeekDesktopRequest, "workspacePath" | "model">): Promise<{ sessionId: string }> {
		const session = await this.client.prepare(request.workspacePath, request.model);
		this.#sessions.set(session.sessionId, session);
		return { sessionId: session.sessionId };
	}

	async run(request: DeepSeekDesktopRequest & { sessionId: string }): Promise<DeepSeekDesktopResult> {
		const session = this.#sessions.get(request.sessionId);
		if (!session) throw new Error(`DeepSeek Harness 会话尚未准备：${request.sessionId}`);
		const result = await this.client.sendAndWait(session, {
			prompt: request.prompt,
			marker: request.resultMarker,
			...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
		});
		return {
			marker: request.resultMarker,
			output: result.output,
			workspacePath: request.workspacePath,
			selectedModel: { ...session.model },
			toolNames: result.toolNames,
		};
	}

	async release(sessionId: string): Promise<void> {
		await this.client.cancel(sessionId).catch(() => undefined);
		this.#sessions.delete(sessionId);
	}

	async pause(sessionId: string): Promise<void> {
		await this.client.cancel(sessionId);
	}

	async cancel(sessionId: string): Promise<void> {
		await this.client.cancel(sessionId);
		this.#sessions.delete(sessionId);
	}
}
