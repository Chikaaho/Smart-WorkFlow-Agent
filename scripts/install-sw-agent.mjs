#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execNpmSync } from "./npm-command.mjs";

const marker = "Smart-WorkFlow-Agent managed launcher";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function shellQuote(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandPaths(prefix) {
	if (process.platform === "win32") {
		return [join(prefix, "sw-agent.cmd"), join(prefix, "sw-agent.ps1")];
	}
	return [join(prefix, "bin", "sw-agent")];
}

function managed(path) {
	return existsSync(path) && readFileSync(path, "utf8").includes(marker);
}

function removeManagedLaunchers(prefix) {
	const paths = commandPaths(prefix);
	for (const path of paths) {
		if (managed(path)) rmSync(path, { force: true });
	}
	console.log(`已移除 sw-agent：${paths.join(", ")}`);
}

function writeUnixLauncher(path) {
	const defaultHome = shellQuote(repoRoot);
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			`# ${marker}`,
			`SW_AGENT_ROOT=\${SW_AGENT_HOME:-${defaultHome}}`,
			'exec node "$SW_AGENT_ROOT/bin/sw-agent.mjs" "$@"',
			"",
		].join("\n"),
		{ encoding: "utf8", mode: 0o755 },
	);
	chmodSync(path, 0o755);
}

function writeWindowsLaunchers(cmdPath, powershellPath) {
	const escapedRoot = repoRoot.replaceAll("%", "%%");
	writeFileSync(
		cmdPath,
		[
			"@ECHO off",
			`REM ${marker}`,
			'IF DEFINED SW_AGENT_HOME (SET "SW_AGENT_ROOT=%SW_AGENT_HOME%") ELSE (SET "SW_AGENT_ROOT=' +
				escapedRoot +
				'")',
			'node "%SW_AGENT_ROOT%\\bin\\sw-agent.mjs" %*',
			"",
		].join("\r\n"),
		"utf8",
	);
	const quotedRoot = repoRoot.replaceAll("'", "''");
	writeFileSync(
		powershellPath,
		[
			`# ${marker}`,
			`$agentRoot = if ($env:SW_AGENT_HOME) { $env:SW_AGENT_HOME } else { '${quotedRoot}' }`,
			'& node (Join-Path $agentRoot "bin\\sw-agent.mjs") @args',
			"exit $LASTEXITCODE",
			"",
		].join("\r\n"),
		"utf8",
	);
}

function normalizedPathEntries() {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((entry) => normalize(resolve(entry)).toLowerCase());
}

const { values } = parseArgs({
	options: {
		prefix: { type: "string" },
		"skip-path-check": { type: "boolean", default: false },
		uninstall: { type: "boolean", default: false },
	},
});

const npmPrefix = values.prefix ?? execNpmSync(["prefix", "-g"], { encoding: "utf8" }).trim();
const [primaryPath, secondaryPath] = commandPaths(npmPrefix);
if (values.uninstall) {
	removeManagedLaunchers(npmPrefix);
	process.exit(0);
}

for (const path of [primaryPath, secondaryPath].filter(Boolean)) {
	if (existsSync(path) && !managed(path)) {
		throw new Error(`拒绝覆盖现有命令：${path}`);
	}
}

mkdirSync(dirname(primaryPath), { recursive: true });
if (process.platform === "win32") writeWindowsLaunchers(primaryPath, secondaryPath);
else writeUnixLauncher(primaryPath);

const binDirectory = dirname(primaryPath);
if (!values["skip-path-check"] && !normalizedPathEntries().includes(normalize(resolve(binDirectory)).toLowerCase())) {
	const instruction =
		process.platform === "win32"
			? `把 ${binDirectory} 加入用户 PATH 后重新打开终端`
			: `把 export PATH=${shellQuote(binDirectory)}:\"$PATH\" 加入 shell 启动文件后重新打开终端`;
	throw new Error(`sw-agent 已安装到 ${primaryPath}，但全局 PATH 尚未包含该目录。${instruction}`);
}

execFileSync(process.execPath, [join(repoRoot, "bin", "sw-agent.mjs"), "--version"], {
	cwd: repoRoot,
	stdio: "inherit",
	env: { ...process.env, SW_AGENT_HOME: repoRoot },
});
console.log(`sw-agent 已安装：${primaryPath}`);
console.log("进入任意项目目录后运行 sw-agent。");
