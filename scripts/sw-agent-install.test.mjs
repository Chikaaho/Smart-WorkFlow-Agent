import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("installs a working sw-agent command", () => {
	const prefix = mkdtempSync(join(tmpdir(), "sw-agent-install-"));
	try {
		execFileSync(
			process.execPath,
			["scripts/install-sw-agent.mjs", "--prefix", prefix, "--skip-path-check"],
			{ cwd: process.cwd(), stdio: "pipe" },
		);
		const command = join(prefix, process.platform === "win32" ? "sw-agent.cmd" : "bin/sw-agent");
		const output = execFileSync(command, ["--version"], {
			cwd: prefix,
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		assert.match(output, /^1\.4\.0\s*$/);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});
