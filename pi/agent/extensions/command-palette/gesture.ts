import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

const HOLD_MS = 200;

/** A gesture owns the key until release, even after its selector closes. */
export function createModelGesture(options: {
	canStart: () => boolean;
	stillFocused: () => boolean;
	open: () => void;
	setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	now?: () => number;
}) {
	// Terminals can acknowledge Kitty input without reporting releases. Start
	// gestures only after this session has received a release event.
	let releasesSeen = false;
	let press: string | undefined;
	let held = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let startedAt = 0;
	const now = options.now ?? (() => performance.now());
	const schedule = options.setTimer ?? setTimeout;
	const cancel = options.clearTimer ?? clearTimeout;

	function reset(): void {
		if (timer !== undefined) cancel(timer);
		timer = undefined;
		press = undefined;
		held = false;
	}

	return {
		input(data: string): { consume?: boolean; data?: string } | undefined {
			if (data.includes("\x1b[200~")) return;
			const seenBefore = releasesSeen;
			if (isKeyRelease(data)) releasesSeen = true;
			// Modifier keys may be released before the period. Kitty then reports
			// the period release without Ctrl, but it still ends this gesture.
			const periodEvent = press !== undefined && /^\x1b\[46(?::[0-9:]*)?;[0-9]+:[23]u$/.test(data);
			if (!periodEvent && !matchesKey(data, "ctrl+.")) return;
			if (press !== undefined) {
				if (isKeyRelease(data)) {
					const original = press;
					const focused = options.stillFocused();
					const expired = !held && now() - startedAt >= HOLD_MS;
					const cycle = !held && !expired && focused;
					reset();
					if (expired && focused) options.open();
					return cycle ? { data: original } : { consume: true };
				}
				return { consume: true };
			}
			// Legacy input and orphaned repeats/releases never start a gesture.
			if (!/^\x1b\[[0-9:]+;[0-9]+(?::1)?u$/.test(data) || isKeyRelease(data) || isKeyRepeat(data) || !seenBefore || !options.canStart()) return;
			press = data;
			startedAt = now();
			timer = schedule(() => {
				timer = undefined;
				held = true;
				if (options.stillFocused()) options.open();
			}, HOLD_MS);
			return { consume: true };
		},
		reset,
	};
}
