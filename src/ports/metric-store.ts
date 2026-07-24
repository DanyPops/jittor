import type { UsageAggregateRow } from "../domain/usage.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../domain/metric.ts";

export interface DistinctScopesFilter {
	source: string;
	since: number;
	until: number;
	limit: number;
}

export interface UsageAggregateFilter {
	source: string;
	/** Only these scopes are summed -- callers pass the bounded result of distinctScopes, so a real explosion of distinct scopes truncates honestly instead of this method silently discovering and aggregating an unbounded set on its own. */
	scopes: string[];
	since: number;
	until: number;
	bucketSizeMs: number;
	bucketCount: number;
}

export interface MetricStore {
	record(observation: MetricObservation): StoredMetricObservation;
	query(filter?: MetricQuery): StoredMetricObservation[];
	/** Bounded distinct scope values for a source within a time window, so callers can fetch a fair share per scope instead of one flat query a single heavy scope could monopolize. */
	distinctScopes(filter: DistinctScopesFilter): string[];
	/**
	 * SQL-side (scope, metric, bucket) sums for a bounded scope list -- result size scales with
	 * (scopes x distinct metrics x buckets), never with raw event count, so a heavy scope's full
	 * history is represented exactly regardless of how many observations fed it. Replaces fetching
	 * up to a fixed number of raw rows per scope, which could silently truncate a single heavy
	 * scope's own older history within the requested window (a real incident: a scope with 49,270
	 * rows in a week had its "weekly" chart built from the 250 most recent rows alone -- 3.3
	 * minutes of real activity mislabeled as a full week).
	 */
	aggregateUsage(filter: UsageAggregateFilter): UsageAggregateRow[];
	pruneBefore(cutoff: number): number;
	checkpoint(): void;
	close(): void;
}
