import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../domain/metric.ts";

export interface MetricStore {
	record(observation: MetricObservation): StoredMetricObservation;
	query(filter?: MetricQuery): StoredMetricObservation[];
	pruneBefore(cutoff: number): number;
	checkpoint(): void;
	close(): void;
}
