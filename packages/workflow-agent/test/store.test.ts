import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRuntimeStore } from "../src/store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createStore(): Promise<WorkflowRuntimeStore> {
	const directory = await mkdtemp(join(tmpdir(), "workflow-store-test-"));
	temporaryDirectories.push(directory);
	return new WorkflowRuntimeStore(directory);
}

describe("WorkflowRuntimeStore", () => {
	it("persists and restores a workflow snapshot while holding the writer lock", async () => {
		const store = await createStore();
		await store.acquire();
		await store.save("filter-pagination", {
			schemaVersion: 1,
			workspace: "/workspace",
			savedAt: 123,
			snapshot: {
				phase: "confirmed",
				confirmedRevision: 1,
				requirement: { id: "filter", revision: 1, goal: "筛选后翻页", acceptance: ["页码为 2 / 2"] },
				attempts: [],
				reviews: [],
			},
		});
		expect(await store.load("filter-pagination")).toMatchObject({
			workspace: "/workspace",
			snapshot: { phase: "confirmed", confirmedRevision: 1 },
		});
		await store.release();
	});

	it("rejects a second writer for the same Workspace runtime", async () => {
		const store = await createStore();
		const competing = new WorkflowRuntimeStore(store.directory);
		await store.acquire();
		await expect(competing.acquire()).rejects.toThrow("已有工作流调度进程");
		await store.release();
	});

	it("replaces a writer lock left by a process that no longer exists", async () => {
		const store = await createStore();
		await mkdir(store.directory, { recursive: true });
		await writeFile(join(store.directory, "writer.lock"), "2147483647\n", "utf8");
		await expect(store.acquire()).resolves.toBeUndefined();
		await store.release();
	});
});
