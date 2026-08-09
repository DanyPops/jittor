import {
	COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES,
	CONTEXT_ASSESSMENT_DEFAULT_WINDOW_MS,
	CONTEXT_ASSESSMENT_QUERY_LIMIT,
} from "../constants.ts";
import type { ContextSnapshot } from "../observability/context-delta.ts";
import type { ContextSnapshotHistory } from "../observability/context-snapshot-history.ts";
import { assessContextTelemetry, estimateCompactionDuration } from "../observability/context-telemetry.ts";
import type { MetricStore } from "../observability/store.ts";
import type { OperationHandlerMap } from "../vehicle/operation-types.ts";

/** Context assessment, content-free snapshots/deltas, and compaction estimates. */
export function contextOperations(metrics: MetricStore, snapshots: ContextSnapshotHistory): OperationHandlerMap {
	return {
		"context.assess": (input) => {
			const until = input.until === undefined ? Date.now() : input.until;
			const since =
				input.since === undefined && typeof until === "number" ? Math.max(0, until - CONTEXT_ASSESSMENT_DEFAULT_WINDOW_MS) : input.since;
			if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || (since as number) < 0 || (until as number) < (since as number))
				throw new Error("context assessment requires non-negative ordered integer bounds");
			const query = { since: since as number, until: until as number, order: "asc" as const, limit: CONTEXT_ASSESSMENT_QUERY_LIMIT };
			const injections = metrics.query({ ...query, source: "papyrus-context", metric: "injected-characters" });
			const compactions = metrics.query({ ...query, source: "pi-context" });
			return assessContextTelemetry(injections, compactions, {
				since: since as number,
				until: until as number,
				truncated: injections.length >= CONTEXT_ASSESSMENT_QUERY_LIMIT || compactions.length >= CONTEXT_ASSESSMENT_QUERY_LIMIT,
			});
		},
		"context.snapshot": (input) => snapshots.record(input as unknown as ContextSnapshot),
		"context.delta": (input) => {
			if (typeof input.session_id !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(input.session_id))
				throw new Error("context delta requires an opaque session_id fingerprint");
			return snapshots.latestDelta(input.session_id);
		},
		"compaction.estimate": () => {
			const rows = metrics.query({
				source: "pi-context",
				scope: "compaction",
				metric: "compaction-duration",
				order: "desc",
				limit: COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES,
			});
			return estimateCompactionDuration(rows);
		},
	};
}
