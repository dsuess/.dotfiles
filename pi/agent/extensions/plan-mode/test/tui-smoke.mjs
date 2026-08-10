import assert from "node:assert/strict";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const core = await import(`${root}/dist/index.js`);
const tuiPackage = await import(`${root}/node_modules/@earendil-works/pi-tui/dist/index.js`);
await core.initTheme("dark", false);
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
		"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
});
const rendererModule = await jiti.import(new URL("../plan-renderer.ts", import.meta.url).pathname);
const actionModule = await jiti.import(new URL("../action-dialog.ts", import.meta.url).pathname);
const stageModule = await jiti.import(new URL("../stage-dialog.ts", import.meta.url).pathname);

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
};

let planRenderer;
rendererModule.registerPlanRenderer({
	registerEntryRenderer(name, renderer) {
		if (name === rendererModule.PLAN_DISPLAY_ENTRY) planRenderer = renderer;
	},
});
const component = planRenderer({ data: {
	markdown: `# Width test\n\n${"A complete approved plan line with wrapping. ".repeat(20)}`,
	path: "/project/.pi/plans/width-test.md", revision: 3, hash: "abc",
}}, { expanded: false }, theme);
for (const width of [24, 40, 80]) {
	const lines = component.render(width);
	assert.ok(lines.length > 4);
	assert.ok(lines.every((line) => tuiPackage.visibleWidth(line) <= width), `renderer exceeded width ${width}`);
}
component.invalidate();
assert.ok(component.render(32).every((line) => tuiPackage.visibleWidth(line) <= 32));

function dialogContext(keys, editorValue = undefined) {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			async custom(factory) {
				return new Promise((resolve) => {
					const component = factory({ requestRender() {} }, theme, {}, resolve);
					for (const width of [28, 60]) assert.ok(component.render(width).every((line) => tuiPackage.visibleWidth(line) <= width));
					for (const key of keys) component.handleInput(key);
				});
			},
			async editor() { return editorValue; },
		},
	};
}

assert.deepEqual(await actionModule.showPlanActionDialog(dialogContext(["\r"])), { action: "run" });
assert.deepEqual(await actionModule.showPlanActionDialog(dialogContext(["\x1b[B", "\r"])), { action: "fast" });
assert.deepEqual(await actionModule.showPlanActionDialog(dialogContext(["\x1b[B", "\x1b[B", "\r"])), { action: "staged" });
assert.deepEqual(await actionModule.showPlanActionDialog(dialogContext(["\x1b"])), { action: "cancel" });
assert.deepEqual(
	await actionModule.showPlanActionDialog(dialogContext(["\x1b[B", "\x1b[B", "\x1b[B", "\r"], "Use the existing helper")),
	{ action: "change", text: "Use the existing helper" },
);
assert.deepEqual(
	await actionModule.showPlanActionDialog(dialogContext(["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r"])),
	{ action: "review" },
);
assert.deepEqual(
	await stageModule.showStageDialog(dialogContext(["\x1b[B", "\r"], "Fix the race"), false),
	{ action: "feedback", text: "Fix the race" },
);
assert.deepEqual(await stageModule.showStageDialog(dialogContext(["\x1b"]), false), { action: "cancel" });
