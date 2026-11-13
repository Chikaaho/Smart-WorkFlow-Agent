export function isWorkflowExitInput(text: string, source: string): boolean {
	return source === "interactive" && (text === "exit" || text === "quit");
}
