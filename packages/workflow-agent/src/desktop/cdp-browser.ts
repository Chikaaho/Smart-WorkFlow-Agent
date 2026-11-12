import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChromeExecutable } from "./platform-paths.ts";

type UnknownRecord = Record<string, unknown>;

interface SocketEvent {
	data?: unknown;
}

interface SocketLike {
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: SocketEvent) => void): void;
	close(): void;
	send(data: string): void;
}

interface SocketConstructor {
	new (url: string): SocketLike;
}

interface PendingCommand {
	resolve(value: UnknownRecord): void;
	reject(error: Error): void;
}

export interface BrowserCommandRequest {
	requestId: string;
	command: UnknownRecord;
}

export interface BrowserCommandResult extends UnknownRecord {
	ok: boolean;
}

export interface VisibleBrowserProvider {
	list(): Promise<UnknownRecord>;
	execute(request: BrowserCommandRequest): Promise<BrowserCommandResult>;
	close(): Promise<void>;
}

export interface ChromeCdpBrowserOptions {
	executable?: string;
	startupTimeoutMs?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value ? value : undefined;
}

function socketData(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
	return String(value);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
	const timeoutAt = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < timeoutAt) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`等待 Chrome 调试端口超时：${path}`, { cause: lastError });
}

class CdpSocket {
	readonly socket: SocketLike;
	#pending = new Map<number, PendingCommand>();
	#nextId = 0;

	private constructor(socket: SocketLike) {
		this.socket = socket;
		this.socket.addEventListener("message", (event) => this.#onMessage(event));
		this.socket.addEventListener("close", () => this.#rejectPending(new Error("Chrome 调试连接已关闭")));
		this.socket.addEventListener("error", () => this.#rejectPending(new Error("Chrome 调试连接出错")));
	}

	static async connect(url: string): Promise<CdpSocket> {
		const Socket = (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket;
		if (!Socket) throw new Error("当前 Node.js 运行时不支持 WebSocket");
		const socket = new Socket(url);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("无法连接 Chrome 调试端口")));
		});
		return new CdpSocket(socket);
	}

	async send(method: string, params: UnknownRecord = {}): Promise<UnknownRecord> {
		this.#nextId += 1;
		const id = this.#nextId;
		return await new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.socket.close();
	}

	#onMessage(event: SocketEvent): void {
		let value: unknown;
		try {
			value = JSON.parse(socketData(event.data));
		} catch {
			return;
		}
		if (!isRecord(value) || typeof value.id !== "number") return;
		const pending = this.#pending.get(value.id);
		if (!pending) return;
		this.#pending.delete(value.id);
		if (isRecord(value.error)) {
			pending.reject(new Error(readString(value.error, "message") ?? "Chrome 调试命令失败"));
			return;
		}
		pending.resolve(isRecord(value.result) ? value.result : {});
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

const SNAPSHOT_EXPRESSION = `(() => {
	const maxElements = 500;
	const interactiveSelector = "a,button,input,select,textarea,[role=button],[role=link],[contenteditable=true]";
	const interactive = Array.from(document.querySelectorAll(interactiveSelector)).slice(0, maxElements);
	const elements = interactive.map((element, index) => {
		const ref = \`pi-\${index + 1}\`;
		element.setAttribute("data-pi-browser-ref", ref);
		const rect = element.getBoundingClientRect();
		const label = element.getAttribute("aria-label") || element.getAttribute("name") || element.textContent || "";
		return {
			ref,
			tag: element.tagName.toLowerCase(),
			role: element.getAttribute("role") || undefined,
			name: label.trim().slice(0, 300) || undefined,
			text: (element.textContent || "").trim().slice(0, 1000) || undefined,
			value: "value" in element ? String(element.value) : undefined,
			disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
			checked: "checked" in element ? Boolean(element.checked) : undefined,
			selector: \`[data-pi-browser-ref="\${ref}"]\`,
			xpath: "",
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			inViewport: rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth,
			attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
		};
	});
	const nodes = Array.from(document.querySelectorAll("body *:not(script):not(style):not(noscript):not(template)"))
		.slice(0, maxElements)
		.map((element) => {
		const rect = element.getBoundingClientRect();
		const directText = Array.from(element.childNodes)
			.filter((node) => node.nodeType === Node.TEXT_NODE)
			.map((node) => node.textContent || "")
			.join(" ")
			.trim();
		return {
			tag: element.tagName.toLowerCase(),
			depth: 0,
			inViewport: rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth,
			ref: element.getAttribute("data-pi-browser-ref") || undefined,
			role: element.getAttribute("role") || undefined,
			name: element.getAttribute("aria-label") || undefined,
			text: directText.slice(0, 1000) || undefined,
			attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
		};
		});
	return { url: location.href, title: document.title, dom: nodes, domTruncated: false, elements, truncated: false };
})()`;

const ELEMENT_ACTION_EXPRESSION = `(input) => {
	const element = document.querySelector(\`[data-pi-browser-ref="\${CSS.escape(input.ref)}"]\`);
	if (!element) return { ok: false, message: "ref not found" };
	if (input.action === "fill") {
		element.value = input.value;
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
	} else if (input.action === "select") {
		element.value = input.values[0] || "";
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
	} else {
		element.click();
	}
	return { ok: true };
}`;

const PLAYWRIGHT_LOCATOR_EXPRESSION = String.raw`(input) => {
	function matcher(source) {
		const match = source.match(/^"(.*)"[is]$/);
		if (match) return match[1].replaceAll('\\"', '"');
		const regex = source.match(/^\/(.*)\/[a-z]*$/i);
		return regex ? regex[1] : source;
	}
	function accessibleName(element) {
		const labelledBy = element.getAttribute("aria-labelledby");
		const labelled = labelledBy ? document.getElementById(labelledBy)?.textContent : "";
		const label = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent : "";
		return (element.getAttribute("aria-label") || labelled || label || element.textContent || "").trim();
	}
	function locate(selector) {
		const first = selector.split(" >> ")[0];
		let elements;
		if (first.startsWith("internal:role=")) {
			const roleMatch = first.match(/^internal:role=([^[]+)/);
			const nameMatch = first.match(/\[name=([^\]]+)\]/);
			const role = roleMatch ? roleMatch[1] : "";
			const css = role === "combobox" ? "select,[role=combobox]" : role === "button" ? "button,[role=button]" : role === "link" ? "a,[role=link]" : '[role="' + CSS.escape(role) + '"]';
			elements = Array.from(document.querySelectorAll(css));
			if (nameMatch) {
				const expected = matcher(nameMatch[1]).toLocaleLowerCase();
				elements = elements.filter((element) => accessibleName(element).toLocaleLowerCase().includes(expected));
			}
		} else if (first.startsWith("internal:text=")) {
			const expected = matcher(first.slice("internal:text=".length)).toLocaleLowerCase();
			elements = Array.from(document.querySelectorAll("body *:not(script):not(style)")).filter((element) =>
				(element.textContent || "").trim().toLocaleLowerCase() === expected,
			);
		} else if (first.startsWith("internal:label=")) {
			const expected = matcher(first.slice("internal:label=".length)).toLocaleLowerCase();
			elements = Array.from(document.querySelectorAll("input,select,textarea")).filter((element) =>
				accessibleName(element).toLocaleLowerCase().includes(expected),
			);
		} else {
			elements = Array.from(document.querySelectorAll(first));
		}
		const nth = selector.match(/ >> nth=(-?\d+)/);
		if (nth) {
			const index = Number(nth[1]);
			const resolved = index < 0 ? elements.at(index) : elements[index];
			return resolved ? [resolved] : [];
		}
		return elements;
	}
	const elements = locate(input.selector);
	const element = elements[0];
	switch (input.operation) {
		case "count": return elements.length;
		case "allTextContents": return elements.map((candidate) => candidate.textContent || "");
		case "textContent": return element?.textContent ?? null;
		case "innerText": return element?.innerText ?? "";
		case "isVisible": return Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height);
		case "isEnabled": return Boolean(element && !element.disabled);
		case "getAttribute": return element?.getAttribute(input.attribute) ?? null;
		case "waitFor": return element ? null : { error: "not found" };
	}
	if (!element) return { error: "not found" };
	if (input.operation === "click" || input.operation === "dblclick") {
		element.click();
		if (input.operation === "dblclick") element.click();
		return null;
	}
	if (input.operation === "fill") {
		element.value = String(input.value ?? "");
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		return null;
	}
	if (input.operation === "selectOption") {
		const selection = input.selections?.[0] || {};
		let value = selection.value;
		if (selection.label !== undefined) {
			value = Array.from(element.options).find((option) => option.textContent?.trim() === selection.label)?.value;
		}
		if (selection.index !== undefined) value = element.options[selection.index]?.value;
		element.value = value ?? "";
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		return [element.value];
	}
	return { error: "unsupported locator operation" };
}`;

export class ChromeCdpBrowser implements VisibleBrowserProvider {
	readonly options: ChromeCdpBrowserOptions;
	#process?: ChildProcess;
	#profileDir?: string;
	#socket?: CdpSocket;
	#tabId?: string;
	#visible = true;

	constructor(options: ChromeCdpBrowserOptions = {}) {
		this.options = options;
	}

	async list(): Promise<UnknownRecord> {
		await this.#ensureStarted();
		const capabilities = [
			"navigate",
			"snapshot",
			"click",
			"fill",
			"select",
			"getState",
			"screenshot",
			"evaluate",
			"playwright",
			"playwrightWaitForTimeout",
			"capabilities",
			"newTab",
			"list",
			"listUserTabs",
			"activateTab",
			"nameSession",
			"browserVisibilityGet",
			"browserVisibilitySet",
			"openScope",
			"releaseScope",
			"finalize",
		];
		return {
			browsers: [
				{
					id: "pi-visible-chrome",
					generation: 1,
					type: "cdp",
					name: "Pi Visible Chrome",
					capabilities: {
						browser: capabilities.map((id) => ({ id, description: id })),
						tab: capabilities.map((id) => ({ id, description: id })),
					},
					metadata: { visible: "true", owner: "pi-workflow-agent" },
				},
			],
		};
	}

	async execute(request: BrowserCommandRequest): Promise<BrowserCommandResult> {
		const startedAt = Date.now();
		const result = await this.#executeCommand(request);
		return { ...result, elapsedMs: Date.now() - startedAt };
	}

	async #executeCommand(request: BrowserCommandRequest): Promise<BrowserCommandResult> {
		await this.#ensureStarted();
		const method = readString(request.command, "method");
		if (!method) return this.#error("execution_error", "浏览器命令缺少 method");
		try {
			switch (method) {
				case "openScope":
					return { ok: true, scope: { id: "pi-visible-chrome-scope", state: "open" }, meta: this.#meta() };
				case "releaseScope":
					return { ok: true, scope: { id: "pi-visible-chrome-scope", state: "released" }, meta: this.#meta() };
				case "newTab":
				case "activateTab":
				case "finalize":
				case "markDeliverable":
				case "markHandoff":
					return { ok: true, tab: await this.#tab(), meta: this.#meta() };
				case "list":
					return { ok: true, tabs: [await this.#tab()], meta: this.#meta() };
				case "listUserTabs": {
					const tab = await this.#tab();
					return {
						ok: true,
						userTabs: [
							{
								id: tab.tabId,
								title: tab.title,
								url: tab.url,
								lastOpened: new Date().toISOString(),
							},
						],
						meta: this.#meta(),
					};
				}
				case "nameSession":
					return { ok: true, value: { name: readString(request.command, "name") }, meta: this.#meta() };
				case "browserVisibilityGet":
					return { ok: true, value: { visible: this.#visible }, meta: this.#meta() };
				case "browserVisibilitySet":
					this.#visible = request.command.visible !== false;
					return { ok: true, value: { visible: this.#visible }, meta: this.#meta() };
				case "navigate":
					return await this.#navigate(request.command);
				case "snapshot":
					return { ok: true, snapshot: await this.#snapshot(), meta: this.#meta() };
				case "getState":
					return { ok: true, state: await this.#state(), tab: await this.#tab(), meta: this.#meta() };
				case "click":
					return await this.#elementAction(request.command, "click");
				case "fill":
					return await this.#elementAction(request.command, "fill");
				case "select":
					return await this.#elementAction(request.command, "select");
				case "evaluate":
					return await this.#evaluateCommand(request.command);
				case "playwright":
					return await this.#playwright(request.command);
				case "playwrightWaitForTimeout":
					await new Promise((resolve) =>
						setTimeout(resolve, typeof request.command.timeoutMs === "number" ? request.command.timeoutMs : 0),
					);
					return { ok: true, meta: this.#meta() };
				case "capabilities":
					return { ok: true, value: { backend: "cdp", visible: true }, meta: this.#meta() };
				case "screenshot":
					return await this.#screenshot();
				default:
					return this.#error("capability_unsupported", `暂不支持浏览器命令 ${method}`);
			}
		} catch (error) {
			return this.#error("execution_error", error instanceof Error ? error.message : String(error));
		}
	}

	async close(): Promise<void> {
		this.#socket?.close();
		this.#socket = undefined;
		if (this.#process && this.#process.exitCode === null) {
			const child = this.#process;
			child.kill("SIGTERM");
			await Promise.race([
				new Promise<void>((resolve) => child.once("close", () => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
			]);
		}
		this.#process = undefined;
		if (this.#profileDir) {
			let lastError: unknown;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await rm(this.#profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
					lastError = undefined;
					break;
				} catch (error) {
					lastError = error;
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			}
			if (lastError) throw new Error(`无法清理 Chrome 临时目录：${this.#profileDir}`, { cause: lastError });
		}
		this.#profileDir = undefined;
	}

	async #ensureStarted(): Promise<void> {
		if (this.#socket) return;
		const executable = this.options.executable ?? (await resolveChromeExecutable());
		const profileDir = await mkdtemp(join(tmpdir(), "pi-workflow-chrome-"));
		const child = spawn(
			executable,
			[
				"--remote-debugging-port=0",
				`--user-data-dir=${profileDir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--new-window",
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		this.#process = child;
		this.#profileDir = profileDir;
		const activePort = await waitForFile(
			join(profileDir, "DevToolsActivePort"),
			this.options.startupTimeoutMs ?? 15_000,
		);
		const [port] = activePort.trim().split(/\r?\n/u);
		if (!port) throw new Error("Chrome 没有返回调试端口");
		const response = await fetch(`http://127.0.0.1:${port}/json/list`);
		if (!response.ok) throw new Error(`Chrome 标签页目录返回 ${response.status}`);
		const targets: unknown = await response.json();
		if (!Array.isArray(targets)) throw new Error("Chrome 标签页目录格式无效");
		const target = targets.find(
			(candidate) =>
				isRecord(candidate) && candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string",
		);
		if (!isRecord(target)) throw new Error("Chrome 没有可控制的可见标签页");
		const socketUrl = readString(target, "webSocketDebuggerUrl");
		const tabId = readString(target, "id");
		if (!socketUrl || !tabId) throw new Error("Chrome 标签页缺少调试标识");
		this.#socket = await CdpSocket.connect(socketUrl);
		this.#tabId = tabId;
		await this.#socket.send("Page.enable");
		await this.#socket.send("Runtime.enable");
	}

	async #navigate(command: UnknownRecord): Promise<BrowserCommandResult> {
		const url = readString(command, "url");
		if (!url) return this.#error("navigation_blocked", "navigate 缺少 URL");
		await this.#cdp("Page.navigate", { url });
		await this.#waitForReady();
		return { ok: true, state: await this.#state(), tab: await this.#tab(), meta: this.#meta() };
	}

	async #waitForReady(): Promise<void> {
		const timeoutAt = Date.now() + 15_000;
		while (Date.now() < timeoutAt) {
			const value = await this.#evaluate("document.readyState");
			if (value === "complete" || value === "interactive") return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("页面加载超时");
	}

	async #snapshot(): Promise<UnknownRecord> {
		const value = await this.#evaluate(SNAPSHOT_EXPRESSION);
		if (!isRecord(value)) throw new Error("页面快照格式无效");
		return value;
	}

	async #state(): Promise<UnknownRecord> {
		const value = await this.#evaluate(
			"({url: location.href, title: document.title, canGoBack: history.length > 1, canGoForward: false, scrollX, scrollY, viewportWidth: innerWidth, viewportHeight: innerHeight})",
		);
		if (!isRecord(value)) throw new Error("页面状态格式无效");
		return value;
	}

	async #tab(): Promise<UnknownRecord> {
		const state = await this.#state();
		return {
			tabId: this.#tabId ?? "pi-visible-tab",
			url: readString(state, "url") ?? "about:blank",
			title: readString(state, "title") ?? "",
			viewport: { width: 1280, height: 720 },
			active: true,
			lifecycle: "active",
		};
	}

	async #elementAction(command: UnknownRecord, action: "click" | "fill" | "select"): Promise<BrowserCommandResult> {
		const ref = readString(command, "ref");
		if (!ref) return this.#error("ref_not_found", `${action} 缺少 ref`);
		const argument =
			action === "fill"
				? { ref, value: typeof command.value === "string" ? command.value : "" }
				: action === "select"
					? {
							ref,
							values: Array.isArray(command.values)
								? command.values.filter((value): value is string => typeof value === "string")
								: [],
						}
					: { ref };
		const expression = `(${ELEMENT_ACTION_EXPRESSION})(${JSON.stringify({ ...argument, action })})`;
		const value = await this.#evaluate(expression);
		if (!isRecord(value) || value.ok !== true) return this.#error("ref_not_found", `页面中找不到 ${ref}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		return { ok: true, state: await this.#state(), meta: this.#meta() };
	}

	async #evaluateCommand(command: UnknownRecord): Promise<BrowserCommandResult> {
		const expression = readString(command, "expression");
		if (!expression) return this.#error("execution_error", "evaluate 缺少 expression");
		return { ok: true, value: await this.#evaluate(expression), meta: this.#meta() };
	}

	async #playwright(command: UnknownRecord): Promise<BrowserCommandResult> {
		if (!isRecord(command.action)) return this.#error("execution_error", "playwright 缺少 action");
		const action = command.action;
		const name = readString(action, "name");
		if (name === "domSnapshot") {
			const snapshot = await this.#snapshot();
			const dom = Array.isArray(snapshot.dom) ? snapshot.dom : [];
			const lines = dom
				.filter(isRecord)
				.map((node) => readString(node, "text"))
				.filter((text): text is string => Boolean(text));
			const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
			for (const element of elements.filter(isRecord)) {
				const tag = readString(element, "tag") ?? "element";
				const label = readString(element, "name") ?? readString(element, "text") ?? "";
				const value = readString(element, "value");
				lines.push(
					`- ${tag} ${JSON.stringify(label)}${value === undefined ? "" : ` value=${JSON.stringify(value)}`}`,
				);
			}
			return { ok: true, value: lines.join("\n"), meta: this.#meta() };
		}
		if (name === "waitForLoadState") {
			await this.#waitForReady();
			return { ok: true, value: null, meta: this.#meta() };
		}
		if (name === "waitForURL") {
			const expected = readString(action, "url");
			const state = await this.#state();
			if (expected && readString(state, "url") !== expected)
				return this.#error("timeout", `页面 URL 尚未变为 ${expected}`);
			return { ok: true, value: null, meta: this.#meta() };
		}
		if (name === "locator") {
			const selector = readString(action, "selector");
			const operation = readString(action, "operation");
			if (!selector || !operation) return this.#error("execution_error", "locator 参数不完整");
			const value = await this.#evaluate(
				`(${PLAYWRIGHT_LOCATOR_EXPRESSION})(${JSON.stringify({ ...action, selector, operation })})`,
			);
			if (isRecord(value) && typeof value.error === "string") return this.#error("ref_not_found", value.error);
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { ok: true, value, meta: this.#meta() };
		}
		if (name === "evaluate") {
			const expression = readString(action, "expression");
			if (!expression) return this.#error("execution_error", "playwright evaluate 缺少 expression");
			const executable =
				action.expressionKind === "function" ? `(${expression})(${JSON.stringify(action.arg)})` : expression;
			return { ok: true, value: await this.#evaluate(executable), meta: this.#meta() };
		}
		return this.#error("capability_unsupported", `暂不支持 playwright.${name ?? "unknown"}`);
	}

	async #screenshot(): Promise<BrowserCommandResult> {
		const result = await this.#cdp("Page.captureScreenshot", { format: "png" });
		const data = readString(result, "data");
		if (!data) throw new Error("Chrome 没有返回截图");
		return { ok: true, image: { base64: data, mimeType: "image/png" }, meta: this.#meta() };
	}

	async #evaluate(expression: string): Promise<unknown> {
		const result = await this.#cdp("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (isRecord(result.exceptionDetails)) throw new Error("页面脚本执行失败");
		if (!isRecord(result.result)) return undefined;
		return result.result.value;
	}

	async #cdp(method: string, params: UnknownRecord = {}): Promise<UnknownRecord> {
		if (!this.#socket) throw new Error("Chrome 尚未连接");
		return await this.#socket.send(method, params);
	}

	#meta(): UnknownRecord {
		return {
			browserUse: true,
			backendType: "cdp",
			browserId: "pi-visible-chrome",
			browserGeneration: 1,
			openTabIds: [this.#tabId ?? "pi-visible-tab"],
			tabId: this.#tabId ?? "pi-visible-tab",
			lifecycle: "active",
		};
	}

	#error(code: string, message: string): BrowserCommandResult {
		return { ok: false, error: { code, message, sideEffect: "none" }, meta: this.#meta() };
	}
}
