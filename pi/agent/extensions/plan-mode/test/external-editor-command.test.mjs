import assert from "node:assert/strict";
import test from "node:test";
import { prepareEditorInvocation, splitEditorCommand } from "../external-editor-command.js";

test("splits configured editor commands without invoking a shell", () => {
	assert.deepEqual(splitEditorCommand(`code --profile "Plan Review"`), ["code", "--profile", "Plan Review"]);
	assert.deepEqual(splitEditorCommand(`'/Applications/My Editor/bin/edit' -w`), ["/Applications/My Editor/bin/edit", "-w"]);
});

test("adds wait flags for known GUI editors and preserves explicit flags", () => {
	assert.deepEqual(prepareEditorInvocation("code", "/tmp/plan.md"), {
		executable: "code",
		args: ["--wait", "/tmp/plan.md"],
	});
	assert.deepEqual(prepareEditorInvocation("code -w", "/tmp/plan.md").args, ["-w", "/tmp/plan.md"]);
	assert.deepEqual(prepareEditorInvocation("nvim", "/tmp/plan.md").args, ["/tmp/plan.md"]);
	assert.deepEqual(prepareEditorInvocation("open -a 'Visual Studio Code'", "/tmp/plan.md").args, ["-a", "Visual Studio Code", "-W", "/tmp/plan.md"]);
});
