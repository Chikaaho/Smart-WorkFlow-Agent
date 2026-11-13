#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execNpmSync } from "./npm-command.mjs";

const repoRoot = process.cwd();
const packageRoot = join(repoRoot, "npm", "sw-agent");
const temporaryRoot = mkdtempSync(join(tmpdir(), "sw-agent-package-smoke-"));
const tarballDirectory = join(temporaryRoot, "tarball");
const consumer = join(temporaryRoot, "consumer");

try {
	mkdirSync(tarballDirectory);
	mkdirSync(consumer);
	execNpmSync(["run", "build"], { cwd: packageRoot, stdio: "inherit" });
	const packOutput = execNpmSync(
		["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory],
		{ cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	const packed = JSON.parse(packOutput);
	const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
	if (typeof filename !== "string") throw new Error("npm pack 没有返回 sw-agent 包文件");
	execNpmSync(["init", "-y"], { cwd: consumer, stdio: "ignore" });
	execNpmSync(["install", "--ignore-scripts", join(tarballDirectory, filename)], {
		cwd: consumer,
		stdio: "inherit",
	});
	const command = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "sw-agent.cmd" : "sw-agent");
	const output = execFileSync(command, ["--version"], {
		cwd: consumer,
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	if (output.trim() !== "1.4.0") throw new Error(`sw-agent 返回了错误版本：${output.trim()}`);
	console.log("sw-agent npm 包安装检查通过。");
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
