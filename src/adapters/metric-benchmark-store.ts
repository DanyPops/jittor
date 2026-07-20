import {
	BENCHMARK_MAX_OBSERVATIONS_PER_SNAPSHOT,
	BENCHMARK_STORE_QUERY_LIMIT,
} from "../constants.ts";
import {
	validateBenchmarkObservation,
	type BenchmarkObservation,
	type BenchmarkSnapshot,
} from "../domain/benchmark.ts";
import type { StoredMetricObservation } from "../domain/metric.ts";
import type { BenchmarkStore } from "../ports/benchmark-store.ts";
import type { MetricStore } from "../ports/metric-store.ts";

const COMPLETE_METRIC = "snapshot-complete";
const SNAPSHOT_SCOPE = "snapshot";

function metricSource(sourceId: string): string {
	return `benchmark:${sourceId}`;
}

function observationAttributes(snapshotId: string, observation: BenchmarkObservation): Record<string, unknown> {
	return {
		snapshotId,
		model: observation.model,
		provenance: observation.provenance,
		methodology: observation.methodology,
	};
}

function decodeObservation(row: StoredMetricObservation): BenchmarkObservation {
	return validateBenchmarkObservation({
		model: row.attributes["model"],
		dimension: row.metric,
		value: row.value,
		unit: row.unit,
		provenance: row.attributes["provenance"],
		methodology: row.attributes["methodology"],
	});
}

export class MetricBenchmarkStore implements BenchmarkStore {
	constructor(private readonly metrics: MetricStore) {}

	publish(sourceId: string, snapshotId: string, input: BenchmarkObservation[]): BenchmarkSnapshot {
		if (input.length > BENCHMARK_MAX_OBSERVATIONS_PER_SNAPSHOT) throw new Error("benchmark snapshot exceeds the observation limit");
		const observations = input.map(validateBenchmarkObservation);
		const existing = this.latest(sourceId);
		if (existing?.snapshotId === snapshotId) return existing;
		const retrievedAt = observations[0]?.provenance.retrievedAt;
		if (retrievedAt === undefined || observations.some((observation) => observation.provenance.sourceId !== sourceId || observation.provenance.retrievedAt !== retrievedAt)) {
			throw new Error("benchmark snapshot provenance mismatch");
		}
		for (const observation of observations) {
			this.metrics.record({
				source: metricSource(sourceId),
				scope: observation.model.canonical,
				metric: observation.dimension,
				value: observation.value,
				unit: observation.unit,
				observedAt: retrievedAt,
				attributes: observationAttributes(snapshotId, observation),
			});
		}
		this.metrics.record({
			source: metricSource(sourceId),
			scope: SNAPSHOT_SCOPE,
			metric: COMPLETE_METRIC,
			value: observations.length,
			unit: "count",
			observedAt: retrievedAt,
			attributes: { snapshotId, sourceId, retrievedAt },
		});
		return { sourceId, snapshotId, retrievedAt, publishedAt: retrievedAt, observations: structuredClone(observations) };
	}

	latest(sourceId: string): BenchmarkSnapshot | null {
		const marker = this.metrics.query({ source: metricSource(sourceId), scope: SNAPSHOT_SCOPE, metric: COMPLETE_METRIC, order: "desc", limit: 1 })[0];
		if (!marker) return null;
		const rows = this.metrics.query({ source: metricSource(sourceId), until: marker.observedAt, order: "desc", limit: BENCHMARK_STORE_QUERY_LIMIT });
		const markerIndex = rows.findIndex((row) => row.id === marker.id);
		if (markerIndex < 0) return null;
		const snapshotId = marker.attributes["snapshotId"];
		const expectedCount = marker.value;
		if (typeof snapshotId !== "string" || typeof expectedCount !== "number" || !Number.isSafeInteger(expectedCount) || expectedCount < 0) return null;
		const matching = rows.slice(markerIndex + 1).filter((row) => row.attributes["snapshotId"] === snapshotId).slice(0, expectedCount);
		if (matching.length !== expectedCount) return null;
		try {
			return {
				sourceId,
				snapshotId,
				retrievedAt: marker.observedAt,
				publishedAt: marker.observedAt,
				observations: matching.reverse().map(decodeObservation),
			};
		} catch {
			return null;
		}
	}
}
