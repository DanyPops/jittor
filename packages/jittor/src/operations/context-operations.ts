import {
	COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES,
	CONTEXT_ASSESSMENT_DEFAULT_WINDOW_MS,
	CONTEXT_ASSESSMENT_QUERY_LIMIT,
} from "../constants.ts";
import { assessContextTelemetry, estimateCompactionDuration } from "../domain/context-telemetry.ts";
import type { MetricStore } from "../ports/metric-store.ts";
import type { OperationHandlerMap } from "./types.ts";

/** context.assess and compaction.estimate -- both read-only projections of recorded metrics, no router/session involvement. */
export function contextOperations(metrics: MetricStore): OperationHandlerMap {
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
