ObjC.import("AppKit");

function sleep(milliseconds) {
	delay(milliseconds / 1000);
}

function stringValue(value) {
	if (value === undefined || value === null) return "";
	try {
		return String(value);
	} catch {
		return "";
	}
}

function readElementText(element) {
	const parts = [];
	for (const property of ["name", "description", "value", "help"]) {
		try {
			const text = stringValue(element[property]());
			if (text && !parts.includes(text)) parts.push(text);
		} catch {
			// 部分 AX 元素不暴露所有属性。
		}
	}
	return parts.join(" ");
}

function taskWindows(process) {
	return process.windows().filter((window) => {
		try {
			return stringValue(window.name()) === "ZCode";
		} catch {
			return false;
		}
	});
}

function markerOutputs(window, marker) {
	const outputs = [];
	for (const element of window.entireContents()) {
		const text = readElementText(element);
		if (!text.includes(marker)) continue;
		const output = text.slice(text.lastIndexOf(marker)).split("\n")[0].trim();
		if (output.length > marker.length) outputs.push(output);
	}
	return outputs;
}

function sendPrompt(systemEvents, prompt) {
	pasteText(systemEvents, prompt);
	systemEvents.keyCode(36);
}

function restoreClipboard(pasteboard, previousText) {
	pasteboard.clearContents;
	if (previousText !== null) pasteboard.setStringForType($(previousText), $.NSPasteboardTypeString);
}

function pasteText(systemEvents, text) {
	const pasteboard = $.NSPasteboard.generalPasteboard;
	const previous = pasteboard.stringForType($.NSPasteboardTypeString);
	const previousText = previous ? ObjC.unwrap(previous) : null;
	pasteboard.clearContents;
	pasteboard.setStringForType($(text), $.NSPasteboardTypeString);
	systemEvents.keystroke("v", { using: ["command down"] });
	sleep(150);
	restoreClipboard(pasteboard, previousText);
}

function waitForProcess(systemEvents, timeoutAt) {
	while (Date.now() < timeoutAt) {
		if (systemEvents.processes.byName("ZCode").exists()) return systemEvents.processes.byName("ZCode");
		sleep(200);
	}
	throw new Error("等待 ZCode 启动超时");
}

function waitForWindow(process, timeoutAt) {
	while (Date.now() < timeoutAt) {
		if (process.windows.length > 0) return process.windows[0];
		sleep(200);
	}
	throw new Error("ZCode 没有可用窗口");
}

function openNewTask(process) {
	for (const labels of [
		{ menu: "文件", item: "新建任务" },
		{ menu: "File", item: "New Task" },
	]) {
		try {
			const menuItem = process.menuBars[0].menuBarItems
				.byName(labels.menu)
				.menus[0].menuItems.byName(labels.item);
			if (!menuItem.exists()) continue;
			menuItem.click();
			return;
		} catch {
			// 尝试下一个界面语言。
		}
	}
	throw new Error("找不到 ZCode 的“文件 → 新建任务”菜单项");
}

function run(argv) {
	const workspacePath = argv[0];
	const prompt = argv[1];
	const marker = argv[2];
	const timeoutMs = Number(argv[3]);
	if (!workspacePath || !prompt || !marker || !Number.isFinite(timeoutMs)) {
		throw new Error("ZCode 桌面驱动参数不完整");
	}

	const timeoutAt = Date.now() + timeoutMs;
	const zcode = Application("ZCode");
	zcode.activate();
	const systemEvents = Application("System Events");
	const process = waitForProcess(systemEvents, timeoutAt);
	process.frontmost = true;
	waitForWindow(process, timeoutAt);

	sleep(1_000);
	process.frontmost = true;
	openNewTask(process);
	sleep(800);
	waitForWindow(process, timeoutAt);
	sendPrompt(systemEvents, prompt);

	while (Date.now() < timeoutAt) {
		sleep(500);
		if (process.windows.length === 0) continue;
		for (const candidateWindow of taskWindows(process)) {
			const outputs = markerOutputs(candidateWindow, marker);
			if (outputs.length < 2) continue;
			return JSON.stringify({ marker, output: outputs[outputs.length - 1], workspacePath });
		}
	}
	throw new Error(`等待 ZCode 结果超时：${marker}`);
}
