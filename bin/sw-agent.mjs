#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function resolveAgentHome() {
	const configured = process.env.SW_AGENT_HOME?.trim();
	if (configured) return resolve(expandHome(configured));
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

const agentHome = resolveAgentHome();
const resolver = join(agentHome, "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const cli = join(agentHome, "packages", "coding-agent", "src", "cli.ts");
const extension = join(agentHome, "examples", "workflow-extension", "smart-workflow.ts");

for (const path of [resolver, cli, extension]) {
	if (!existsSync(path)) {
		console.error(`sw-agent 安装不完整，缺少文件：${path}`);
		console.error("请在 Smart-WorkFlow-Agent 仓库运行 npm ci --ignore-scripts && npm run install:local");
		process.exit(1);
	}
}

const child = spawn(
	process.execPath,
	["--import", pathToFileURL(resolver).href, cli, "--extension", extension, ...process.argv.slice(2)],
	{
		cwd: process.cwd(),
		stdio: "inherit",
		env: { ...process.env, SW_AGENT_HOME: agentHome },
	},
);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
	console.error(`sw-agent 启动失败：${error.message}`);
	process.exitCode = 1;
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exitCode = code ?? 1;
});
