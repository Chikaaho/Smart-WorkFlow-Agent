import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(packageRoot));
execFileSync(process.execPath, ["dist/cli.js", "--version"], {
	cwd: packageRoot,
	stdio: "inherit",
	env: { ...process.env, SW_AGENT_HOME: repoRoot },
});
