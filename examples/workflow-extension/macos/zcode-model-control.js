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

function elementLabel(element) {
	for (const property of ["name", "description", "value"]) {
		try {
			const value = stringValue(element[property]());
			if (value) return value;
		} catch {
			// 部分 AX 元素不暴露所有属性。
		}
	}
	return "";
}

function elementPosition(element) {
	try {
		const position = element.position();
		return { x: Number(position[0]), y: Number(position[1]) };
	} catch {
		return null;
	}
}

function findElement(window, timeoutAt, predicate) {
	while (Date.now() < timeoutAt) {
		for (const element of window.entireContents()) {
			if (predicate(element)) return element;
		}
		sleep(200);
	}
	return null;
}

function clickElement(systemEvents, element) {
	if (!element) throw new Error("找不到要点击的 ZCode 模型控件");
	systemEvents.click(element);
	sleep(500);
}

function openModelPicker(systemEvents, window, timeoutAt) {
	const picker = findElement(window, timeoutAt, (element) => {
		try {
			if (element.role() !== "AXPopUpButton") return false;
			const label = elementLabel(element);
			const normalized = label.toLowerCase();
			return label.includes("/") && (normalized.includes("deepseek") || normalized.includes("glm"));
		} catch {
			return false;
		}
	});
	clickElement(systemEvents, picker);
}

function openProviderPicker(systemEvents, window, timeoutAt) {
	const picker = findElement(window, timeoutAt, (element) =>
		elementLabel(element).startsWith("供应商:"),
	);
	clickElement(systemEvents, picker);
}

function selectProvider(systemEvents, window, timeoutAt, providerName) {
	const provider = findElement(window, timeoutAt, (element) =>
		elementLabel(element).startsWith(providerName),
	);
	if (!provider) throw new Error(`ZCode 模型列表中没有服务商 ${providerName}`);
	const position = elementPosition(provider);
	clickElement(systemEvents, provider);
	return position;
}

function selectModel(systemEvents, window, timeoutAt, modelName, providerPosition) {
	const model = findElement(window, timeoutAt, (element) => {
		if (!elementLabel(element).startsWith(modelName)) return false;
		if (!providerPosition) return true;
		const position = elementPosition(element);
		return position !== null && position.x > providerPosition.x;
	});
	if (!model) throw new Error(`ZCode 服务商中没有模型 ${modelName}`);
	clickElement(systemEvents, model);
}

function readSelection(window, timeoutAt, providerName, modelName) {
	const picker = findElement(window, timeoutAt, (element) => {
		try {
			if (element.role() !== "AXPopUpButton") return false;
			const label = elementLabel(element);
			return label.includes(providerName) && label.includes(modelName);
		} catch {
			return false;
		}
	});
	if (!picker) throw new Error(`ZCode 未切换到 ${providerName}/${modelName}`);
	return elementLabel(picker);
}

function run(argv) {
	const providerName = argv[0];
	const modelName = argv[1];
	const timeoutMs = Number(argv[2]);
	if (!providerName || !modelName || !Number.isFinite(timeoutMs)) {
		throw new Error("ZCode 模型控制参数不完整");
	}

	const timeoutAt = Date.now() + timeoutMs;
	const systemEvents = Application("System Events");
	if (!systemEvents.processes.byName("ZCode").exists()) throw new Error("ZCode 尚未启动");
	const process = systemEvents.processes.byName("ZCode");
	process.frontmost = true;
	const window = process.windows[0];

	systemEvents.keyCode(53);
	sleep(300);
	openModelPicker(systemEvents, window, timeoutAt);
	openProviderPicker(systemEvents, window, timeoutAt);
	const providerPosition = selectProvider(systemEvents, window, timeoutAt, providerName);
	selectModel(systemEvents, window, timeoutAt, modelName, providerPosition);
	systemEvents.keyCode(53);
	sleep(500);
	const selectedLabel = readSelection(window, timeoutAt, providerName, modelName);
	return JSON.stringify({ providerName, modelName, selectedLabel });
}
