import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowSnapshot } from "./workflow.ts";

export interface StoredWorkflowRuntime {
	schemaVersion: 1;
	workspace: string;
	savedAt: number;
	snapshot: WorkflowSnapshot;
}

export interface StoredWorkflowRun {
	id: string;
	runtime: StoredWorkflowRuntime;
}

export class WorkflowRuntimeStore {
	readonly directory: string;
	#lock?: FileHandle;

	constructor(directory: string) {
		this.directory = directory;
	}

	async acquire(): Promise<void> {
		if (this.#lock) return;
		await mkdir(this.directory, { recursive: true });
		const lockPath = join(this.directory, "writer.lock");
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				this.#lock = await open(lockPath, "wx");
				await this.#lock.writeFile(`${process.pid}\n`, "utf8");
				return;
			} catch (error) {
				if (attempt === 0 && isErrorCode(error, "EEXIST") && !(await lockOwnerIsAlive(lockPath))) {
					await rm(lockPath, { force: true });
					continue;
				}
				throw new Error(`Workspace 已有工作流调度进程：${lockPath}`, { cause: error });
			}
		}
	}

	async save(id: string, runtime: StoredWorkflowRuntime): Promise<string> {
		if (!this.#lock) throw new Error("保存工作流前必须取得写锁");
		const path = this.#path(id);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		await open(temporary, "wx").then(async (handle) => {
			try {
				await handle.writeFile(`${JSON.stringify(runtime, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		});
		await rename(temporary, path);
		return path;
	}

	async load(id: string): Promise<StoredWorkflowRuntime | undefined> {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(this.#path(id), "utf8"));
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) return undefined;
			throw new Error(`无法读取工作流运行记录：${id}`, { cause: error });
		}
		if (!isStoredRuntime(value)) throw new Error(`工作流运行记录格式无效：${id}`);
		return value;
	}

	async list(workspace?: string): Promise<StoredWorkflowRun[]> {
		let names: string[];
		try {
			names = await readdir(join(this.directory, "runs"));
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) return [];
			throw new Error("无法读取工作流运行记录目录", { cause: error });
		}
		const runs: StoredWorkflowRun[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -".json".length);
			if (!/^[A-Za-z0-9_-]+$/u.test(id)) continue;
			const runtime = await this.load(id);
			if (runtime && (!workspace || runtime.workspace === workspace)) runs.push({ id, runtime });
		}
		return runs.toSorted((left, right) => right.runtime.savedAt - left.runtime.savedAt);
	}

	async latestActive(workspace: string): Promise<StoredWorkflowRun | undefined> {
		return (await this.list(workspace)).find(
			(run) => run.runtime.snapshot.phase !== "accepted" && run.runtime.snapshot.phase !== "cancelled",
		);
	}

	async release(): Promise<void> {
		if (!this.#lock) return;
		await this.#lock.close();
		this.#lock = undefined;
		await rm(join(this.directory, "writer.lock"), { force: true });
	}

	#path(id: string): string {
		if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error(`工作流记录 ID 无效：${id}`);
		return join(this.directory, "runs", `${id}.json`);
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function lockOwnerIsAlive(lockPath: string): Promise<boolean> {
	let pid: number;
	try {
		pid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
	} catch {
		return false;
	}
	if (!Number.isInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isErrorCode(error, "EPERM");
	}
}

function isStoredRuntime(value: unknown): value is StoredWorkflowRuntime {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const snapshot = record.snapshot;
	return (
		record.schemaVersion === 1 &&
		typeof record.workspace === "string" &&
		typeof record.savedAt === "number" &&
		typeof snapshot === "object" &&
		snapshot !== null &&
		!Array.isArray(snapshot) &&
		isWorkflowSnapshotRecord(snapshot as Record<string, unknown>)
	);
}

function isWorkflowSnapshotRecord(snapshot: Record<string, unknown>): boolean {
	const phases = new Set(["draft", "confirmed", "executing", "pending_review", "accepted", "paused", "cancelled"]);
	return (
		typeof snapshot.phase === "string" &&
		phases.has(snapshot.phase) &&
		Array.isArray(snapshot.attempts) &&
		(snapshot.reviews === undefined || Array.isArray(snapshot.reviews))
	);
}
