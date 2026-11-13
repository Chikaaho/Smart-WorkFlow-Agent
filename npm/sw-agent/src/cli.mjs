#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDist = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(packageDist);
const extension = join(packageDist, "extension", "smart-workflow.js");

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function findCodingAgentPackage(start) {
	let directory = start;
	while (true) {
		const candidate = join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("找不到 @earendil-works/pi-coding-agent，请重新安装 @sw-agent/cli");
}

const configuredHome = process.env.SW_AGENT_HOME?.trim();
const sourceHome = configuredHome ? resolve(expandHome(configuredHome)) : undefined;
const codingAgentPackage = sourceHome ? undefined : findCodingAgentPackage(packageDist);
const piCli = sourceHome
	? join(sourceHome, "packages", "coding-agent", "src", "cli.ts")
	: join(codingAgentPackage, "dist", "bundle", "cli.js");
const nodeArgs = sourceHome
	? [
			"--import",
			pathToFileURL(
				join(sourceHome, "packages", "coding-agent", "src", "experimental", "source-resolver.ts"),
			).href,
		]
	: [];

for (const path of [piCli, extension]) {
	if (!existsSync(path)) {
		console.error(`sw-agent 安装不完整，缺少文件：${path}`);
		console.error("请重新运行 npm install -g @sw-agent/cli");
		process.exit(1);
	}
}

if (codingAgentPackage) {
	const ownManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const manifest = JSON.parse(readFileSync(join(codingAgentPackage, "package.json"), "utf8"));
	const expectedVersion = ownManifest.dependencies?.["@earendil-works/pi-coding-agent"];
	if (manifest.version !== expectedVersion) {
		console.error(
			`sw-agent 需要 @earendil-works/pi-coding-agent ${expectedVersion}，当前为 ${manifest.version ?? "未知"}`,
		);
		process.exit(1);
	}
}

const child = spawn(process.execPath, [...nodeArgs, piCli, "--extension", extension, ...process.argv.slice(2)], {
	cwd: process.cwd(),
	stdio: "inherit",
	env: process.env,
});

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
