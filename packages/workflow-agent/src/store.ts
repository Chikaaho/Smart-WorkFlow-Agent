import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowSnapshot } from "./workflow.ts";

export interface StoredWorkflowRuntime {
	schemaVersion: 1;
	workspace: string;
	savedAt: number;
	snapshot: WorkflowSnapshot;
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
		try {
			this.#lock = await open(lockPath, "wx");
			await this.#lock.writeFile(`${process.pid}\n`, "utf8");
		} catch (error) {
			throw new Error(`Workspace 已有工作流调度进程：${lockPath}`, { cause: error });
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
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw new Error(`无法读取工作流运行记录：${id}`, { cause: error });
		}
		if (!isStoredRuntime(value)) throw new Error(`工作流运行记录格式无效：${id}`);
		return value;
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

function isStoredRuntime(value: unknown): value is StoredWorkflowRuntime {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.schemaVersion === 1 &&
		typeof record.workspace === "string" &&
		typeof record.savedAt === "number" &&
		typeof record.snapshot === "object" &&
		record.snapshot !== null &&
		!Array.isArray(record.snapshot)
	);
}
