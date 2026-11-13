import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_PROJECT_WORKSPACE_TEMPLATE = "https://github.com/Chikaaho/Smart-WorkFlow-Agent-Workspace.git";

export interface ProjectWorkspaceDraft {
	workspacePath: string;
	finalPath: string;
	finalize(): Promise<void>;
	discard(): Promise<void>;
}

export interface GitCommandRunner {
	run(args: readonly string[]): Promise<void>;
}

class LocalGitCommandRunner implements GitCommandRunner {
	async run(args: readonly string[]): Promise<void> {
		await execFileAsync("git", [...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function projectWorkspacePath(projectRoot: string): string {
	return join(projectRoot, ".workflow", "workspace");
}

export async function assertProjectWorkspaceReady(workspacePath: string): Promise<void> {
	const required = [
		join(workspacePath, ".codex", "governance", "execution-supervisor.py"),
		join(workspacePath, "project.md"),
		join(workspacePath, "knowledge", "project-materials.md"),
		join(workspacePath, "knowledge", "current-status.md"),
		join(workspacePath, "knowledge", "architecture.md"),
		join(workspacePath, "memory", "state.md"),
		join(workspacePath, "memory", "architecture.md"),
	];
	for (const path of required) {
		if (!(await pathExists(path))) throw new Error(`项目 Workspace 缺少 ${path}`);
	}
	const project = await readFile(join(workspacePath, "project.md"), "utf8");
	if (project.includes("等待 Executor 根据接入材料补全")) {
		throw new Error("项目 Workspace 的 project.md 尚未完成初始化");
	}
	const status = await readFile(join(workspacePath, "knowledge", "current-status.md"), "utf8");
	if (status.includes("尚未接入具体项目")) {
		throw new Error("项目 Workspace 的 knowledge/current-status.md 尚未完成初始化");
	}
	const architecture = await readFile(join(workspacePath, "knowledge", "architecture.md"), "utf8");
	if (architecture.includes("当前无项目架构记录")) {
		throw new Error("项目 Workspace 的 knowledge/architecture.md 尚未完成初始化");
	}
	for (const relativePath of ["memory/state.md", "memory/architecture.md"]) {
		const content = await readFile(join(workspacePath, relativePath), "utf8");
		if (content.includes("Engine 通用初始版")) {
			throw new Error(`项目 Workspace 的 ${relativePath} 尚未完成初始化`);
		}
	}
}

export async function createProjectWorkspaceDraft(input: {
	projectRoot: string;
	materials: string;
	templateSource?: string;
	git?: GitCommandRunner;
}): Promise<ProjectWorkspaceDraft> {
	const materials = input.materials.trim();
	if (!materials) throw new Error("项目材料不能为空");
	const finalPath = projectWorkspacePath(input.projectRoot);
	if (await pathExists(finalPath)) throw new Error(`项目 Workspace 已存在：${finalPath}`);
	await mkdir(dirname(finalPath), { recursive: true });
	const workspacePath = `${finalPath}.init-${randomUUID()}`;
	const source = input.templateSource?.trim() || DEFAULT_PROJECT_WORKSPACE_TEMPLATE;
	const git = input.git ?? new LocalGitCommandRunner();
	const materialDocument = [
		"# 项目接入材料",
		"",
		`- **代码仓目录**：${input.projectRoot}`,
		`- **模板来源**：${source}`,
		`- **记录时间**：${new Date().toISOString()}`,
		"",
		"## 用户提供的原始材料",
		"",
		materials,
		"",
	].join("\n");
	let finalized = false;
	try {
		await git.run(["clone", "--branch", "main", source, workspacePath]);
		await git.run(["-C", workspacePath, "switch", "-c", "project"]);
		await git.run(["-C", workspacePath, "remote", "rename", "origin", "template"]);
		await git.run(["-C", workspacePath, "remote", "set-url", "--push", "template", "DISABLED"]);
		await writeFile(
			join(workspacePath, "project.md"),
			[
				"# 项目说明",
				"",
				`- **项目名称**：${basename(input.projectRoot)}`,
				"- **一句话目标**：等待 Executor 根据接入材料补全",
				`- **代码仓目录**：${input.projectRoot}`,
				"- **Workspace 来源**：通用 Workspace `main`",
				"",
				"详细字段按 `project.example.md` 补全。",
				"",
			].join("\n"),
			"utf8",
		);
		await writeFile(join(workspacePath, "knowledge", "project-materials.md"), materialDocument, "utf8");
	} catch (error) {
		await rm(workspacePath, { recursive: true, force: true });
		throw error;
	}
	return {
		workspacePath,
		finalPath,
		async finalize() {
			const currentMaterials = await readFile(join(workspacePath, "knowledge", "project-materials.md"), "utf8");
			if (currentMaterials !== materialDocument) throw new Error("项目 Workspace 的原始接入材料已被修改");
			await assertProjectWorkspaceReady(workspacePath);
			if (await pathExists(finalPath)) throw new Error(`项目 Workspace 已存在：${finalPath}`);
			await rename(workspacePath, finalPath);
			finalized = true;
		},
		async discard() {
			if (!finalized) await rm(workspacePath, { recursive: true, force: true });
		},
	};
}
