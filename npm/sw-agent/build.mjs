#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(packageRoot));
const dist = join(packageRoot, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "extension"), { recursive: true });

await build({
	entryPoints: [join(repoRoot, "examples", "workflow-extension", "smart-workflow.ts")],
	outfile: join(dist, "extension", "smart-workflow.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: false,
	alias: {
		"@earendil-works/pi-workflow-agent": join(repoRoot, "packages", "workflow-agent", "src", "index.ts"),
	},
	external: ["@earendil-works/pi-coding-agent"],
});

copyFileSync(join(packageRoot, "src", "cli.mjs"), join(dist, "cli.js"));
chmodSync(join(dist, "cli.js"), 0o755);
for (const name of ["workflow.config.example.yaml", "workflow.deepseek.config.example.yaml"]) {
	copyFileSync(join(repoRoot, "examples", "workflow-extension", name), join(dist, "extension", name));
}
