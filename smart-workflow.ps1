$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionPath = Join-Path $scriptDir "examples\workflow-extension\smart-workflow.ts"

& (Join-Path $scriptDir "pi-test.ps1") --extension $extensionPath @args
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
