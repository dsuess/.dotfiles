import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export default function herdrShiftEnter(pi: ExtensionAPI): void {
  let unsubscribe: (() => void) | undefined;

  function cleanup(): void {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    if (ctx.mode !== "tui" || process.env.TERM_PROGRAM !== "herdr") return;

    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data)) return;
      // Herdr decodes Ghostty's legacy mapping as Alt+Enter, then encodes it
      // again for the pane's negotiated keyboard protocol.
      if (data === "\x1b\r" || matchesKey(data, "alt+enter")) {
        return { data: "\x1b[13;2u" };
      }
    });
  });

  pi.on("session_shutdown", cleanup);
}
