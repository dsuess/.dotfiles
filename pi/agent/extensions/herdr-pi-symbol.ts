import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "dotfiles:pi-symbol";
const PI_SOURCE = "herdr:pi";

function reportPiSymbol(): void {
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !paneId) return;

	spawn("herdr", [
		"pane", "report-metadata", paneId,
		"--source", SOURCE,
		"--applies-to-source", PI_SOURCE,
		"--display-agent", "π",
	], { detached: true, stdio: "ignore" }).unref();
}

export default function herdrPiSymbol(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") reportPiSymbol();
	});
}
