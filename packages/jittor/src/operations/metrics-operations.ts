import {
	MAX_USAGE_BUCKETS,
	METRIC_BATCH_MAX_OBSERVATIONS,
	PRUNE_MIN_AGE_MS,
	TASK_COST_QUERY_LIMIT,
	USAGE_MAX_DISTINCT_SCOPES,
} from "../constants.ts";
import { type MetricQuery, validateMetricObservation } from "../domain/metric.ts";
import { buildTaskCostSummary } from "../domain/task-cost.ts";
import type { MetricStore } from "../ports/metric-store.ts";
import type { OperationHandlerMap } from "./types.ts";

/** metrics.* and service.checkpoint -- every operation whose only collaborator is the metric-store port. */
export function metricsOperations(metrics: MetricStore): OperationHandlerMap {
	return {
		"metrics.record": (input) => metrics.record(validateMetricObservation(input)),
		"metrics.record_batch": (input) => {
			const observations = input.observations;
			if (!Array.isArray(observations) || observations.length === 0) throw new Error("observations must be a non-empty array");
			if (observations.length > METRIC_BATCH_MAX_OBSERVATIONS)
				throw new Error(`observations must contain at most ${METRIC_BATCH_MAX_OBSERVATIONS} entries`);
			return metrics.recordBatch(observations.map((observation) => validateMetricObservation(observation)));
		},
		"metrics.query": (input) => metrics.query(input as MetricQuery),
		"metrics.distinct_scopes": (input) => {
			const source = input.source;
			const since = input.since;
			const until = input.until;
			if (typeof source !== "string" || source.length === 0) throw new Error("source is required");
			if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || (since as number) < 0 || (until as number) < (since as number)) {
				throw new Error("distinct scopes requires non-negative ordered integer bounds");
			}
			const requestedLimit = input.limit;
			const limit = Number.isFinite(requestedLimit)
				? Math.max(1, Math.min(USAGE_MAX_DISTINCT_SCOPES, Math.floor(requestedLimit as number)))
				: USAGE_MAX_DISTINCT_SCOPES;
			return metrics.distinctScopes({ source, since: since as number, until: until as number, limit });
		},
		"metrics.usage_series": (input) => {
			const source = input.source;
			const since = input.since;
			const until = input.until;
			const bucketSizeMs = input.bucketSizeMs;
			const bucketCount = input.bucketCount;
			if (typeof source !== "string" || source.length === 0) throw new Error("source is required");
			if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || (since as number) < 0 || (until as number) < (since as number)) {
				throw new Error("usage series requires non-negative ordered integer bounds");
			}
			if (typeof bucketSizeMs !== "number" || !Number.isFinite(bucketSizeMs) || bucketSizeMs <= 0)
				throw new Error("bucketSizeMs must be a positive number");
			if (!Number.isInteger(bucketCount) || (bucketCount as number) <= 0 || (bucketCount as number) > MAX_USAGE_BUCKETS) {
				throw new Error(`bucketCount must be a positive integer up to ${MAX_USAGE_BUCKETS}`);
			}
			const requestedScopeLimit = input.scopeLimit;
			const scopeLimit = Number.isFinite(requestedScopeLimit)
				? Math.max(1, Math.min(USAGE_MAX_DISTINCT_SCOPES, Math.floor(requestedScopeLimit as number)))
				: USAGE_MAX_DISTINCT_SCOPES;
			const scopes = metrics.distinctScopes({ source, since: since as number, until: until as number, limit: scopeLimit });
			// More distinct scopes may exist beyond this bounded list -- that is the only remaining
			// truncation risk once aggregation replaces a per-scope raw-row fetch (see aggregateUsage's
			// own doc comment for the incident this was built to stop repeating).
			const truncated = scopes.length >= scopeLimit;
			const rows =
				scopes.length === 0
					? []
					: metrics.aggregateUsage({
							source,
							scopes,
							since: since as number,
							until: until as number,
							bucketSizeMs,
							bucketCount: bucketCount as number,
						});
			return { rows, truncated };
		},
		"metrics.cost_by_task": (input) => {
			const since = input.since;
			const until = input.until;
			if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || (since as number) < 0 || (until as number) < (since as number)) {
				throw new Error("cost by task requires non-negative ordered integer bounds");
			}
			const rows = metrics.query({
				source: "pi",
				since: since as number,
				until: until as number,
				order: "desc",
				limit: TASK_COST_QUERY_LIMIT,
			});
			return buildTaskCostSummary(rows, {
				since: since as number,
				until: until as number,
				truncated: rows.length >= TASK_COST_QUERY_LIMIT,
			});
		},
		"metrics.prune": (input) => {
			const before = input.before;
			if (typeof before !== "number") throw new Error("before is required");
			const force = input.force === true;
			const minCutoff = Date.now() - PRUNE_MIN_AGE_MS;
			if (!force && before > minCutoff) {
				throw new Error(
					`refusing to prune metrics newer than ${new Date(minCutoff).toISOString()} without force: true (this looked like it could delete recent or live data)`,
				);
			}
			return { deleted: metrics.pruneBefore(before) };
		},
		"service.checkpoint": () => {
			metrics.checkpoint();
			return { ok: true };
		},
	};
}
