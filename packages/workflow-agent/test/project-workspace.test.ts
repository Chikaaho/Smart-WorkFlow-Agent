import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	assertProjectWorkspaceReady,
	createProjectWorkspaceDraft,
	projectWorkspacePath,
	resolveProjectDirectory,
} from "../src/project-workspace.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function createTemplate(root: string): Promise<string> {
	const template = join(root, "template");
	await mkdir(join(template, ".codex", "governance"), { recursive: true });
	await mkdir(join(template, "knowledge"), { recursive: true });
	await mkdir(join(template, "memory"), { recursive: true });
	await writeFile(join(template, ".codex", "governance", "execution-supervisor.py"), "print('{}')\n", "utf8");
	await writeFile(join(template, "project.example.md"), "# project template\n", "utf8");
	await writeFile(join(template, "knowledge", "current-status.md"), "# 当前状态\n\n尚未接入具体项目\n", "utf8");
	await writeFile(join(template, "knowledge", "architecture.md"), "# 架构\n\n当前无项目架构记录\n", "utf8");
	await writeFile(join(template, "memory", "state.md"), "# 状态\n\nEngine 通用初始版\n", "utf8");
	await writeFile(join(template, "memory", "architecture.md"), "# 架构\n\nEngine 通用初始版\n", "utf8");
	await git(template, "init", "-b", "main");
	await git(template, "config", "user.name", "Test");
	await git(template, "config", "user.email", "test@example.com");
	await git(template, "add", ".");
	await git(template, "commit", "-m", "init template");
	return template;
}

describe("project workspace initialization", () => {
	it("uses one local workspace path per project", () => {
		expect(projectWorkspacePath("/projects/demo")).toBe("/projects/demo/.workflow/workspace");
	});

	it("resolves an execution directory relative to the active project", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-project-directory-"));
		try {
			const first = join(root, "first");
			const second = join(root, "second");
			await mkdir(first);
			await mkdir(second);
			await expect(resolveProjectDirectory(first, "../second")).resolves.toBe(await realpath(second));
			await expect(resolveProjectDirectory(first, "../missing")).rejects.toThrow("项目目录不存在");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("forks the template and finalizes initialized project knowledge", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-project-workspace-"));
		try {
			const template = await createTemplate(root);
			const projectRoot = join(root, "project");
			await mkdir(projectRoot);
			const draft = await createProjectWorkspaceDraft({
				projectRoot,
				materials: "这是一个本地任务管理工具。",
				templateSource: template,
			});
			expect(await readFile(join(draft.workspacePath, "knowledge", "project-materials.md"), "utf8")).toContain(
				"本地任务管理工具",
			);
			await expect(assertProjectWorkspaceReady(draft.workspacePath)).rejects.toThrow("project.md 尚未完成初始化");
			await writeFile(
				join(draft.workspacePath, "project.md"),
				`# 项目说明\n\n- 项目：demo\n- 代码仓：${projectRoot}\n`,
				"utf8",
			);
			await writeFile(
				join(draft.workspacePath, "knowledge", "current-status.md"),
				"# 当前状态\n\n- 已完成项目接入\n",
				"utf8",
			);
			await writeFile(
				join(draft.workspacePath, "knowledge", "architecture.md"),
				"# 架构\n\n- TypeScript 单体仓库\n",
				"utf8",
			);
			await writeFile(join(draft.workspacePath, "memory", "state.md"), "# 状态\n\n- 已接入 demo\n", "utf8");
			await writeFile(
				join(draft.workspacePath, "memory", "architecture.md"),
				"# 架构\n\n- TypeScript 单体仓库\n",
				"utf8",
			);
			await draft.finalize();
			await expect(assertProjectWorkspaceReady(draft.finalPath)).resolves.toBeUndefined();
			const remotes = await execFileAsync("git", ["-C", draft.finalPath, "remote"], { encoding: "utf8" });
			expect(remotes.stdout.trim()).toBe("template");
			const pushUrl = await execFileAsync(
				"git",
				["-C", draft.finalPath, "remote", "get-url", "--push", "template"],
				{
					encoding: "utf8",
				},
			);
			expect(pushUrl.stdout.trim()).toBe("DISABLED");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refuses to finalize when the original project materials were changed", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-project-workspace-"));
		try {
			const template = await createTemplate(root);
			const projectRoot = join(root, "project");
			await mkdir(projectRoot);
			const draft = await createProjectWorkspaceDraft({
				projectRoot,
				materials: "必须原样保留的用户材料",
				templateSource: template,
			});
			await writeFile(join(draft.workspacePath, "knowledge", "project-materials.md"), "材料已被改写\n", "utf8");
			await expect(draft.finalize()).rejects.toThrow("原始接入材料已被修改");
			await draft.discard();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
