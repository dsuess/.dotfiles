/**
 * Internal semantic contract between the human-feedback reducer and the local
 * Herdr reporter. The payload is a complete source snapshot, never an edge.
 */
export const HERDR_FEEDBACK_SNAPSHOT_EVENT = "herdr:feedback-snapshot" as const;

/** Compatibility edge for Herdr's generated direct-socket integration. */
export const HERDR_BLOCKED_EVENT = "herdr:blocked" as const;

export interface HerdrFeedbackSource {
	/** Stable producer key; UI fallback operations use a unique `ui:*` key. */
	id: string;
	/** Safe, user-facing attribution for diagnostics and the Herdr message. */
	label: string;
}

export interface HerdrFeedbackSnapshot {
	/** Every currently active human-feedback source, sorted by stable key. */
	sources: readonly HerdrFeedbackSource[];
}
