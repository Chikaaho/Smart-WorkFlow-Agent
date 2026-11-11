function run() {
	const systemEvents = Application("System Events");
	const process = systemEvents.processes.byName("ZCode");
	if (!process.exists()) throw new Error("ZCode 未运行");
	const taskWindows = process.windows().filter((window) => {
		try {
			return String(window.name()) === "ZCode";
		} catch {
			return false;
		}
	});
	if (taskWindows.length === 0) throw new Error("ZCode 没有可用的任务窗口");
	process.frontmost = true;
	try {
		taskWindows[0].actions.byName("AXRaise").perform();
	} catch {
		// 窗口已经位于前台时不需要 AXRaise。
	}
	delay(0.2);
	systemEvents.keyCode(125);
	delay(0.2);
	systemEvents.keyCode(36);
	return "已为当前 ZCode 项目批准 Browser Use 权限。";
}
