import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../domain/metric.ts";

export interface DistinctScopesFilter {
	source: string;
	since: number;
	until: number;
	limit: number;
}

export interface MetricStore {
	record(observation: MetricObservation): StoredMetricObservation;
	query(filter?: MetricQuery): StoredMetricObservation[];
	/** Bounded distinct scope values for a source within a time window, so callers can fetch a fair share per scope instead of one flat query a single heavy scope could monopolize. */
	distinctScopes(filter: DistinctScopesFilter): string[];
	pruneBefore(cutoff: number): number;
	checkpoint(): void;
	close(): void;
}
