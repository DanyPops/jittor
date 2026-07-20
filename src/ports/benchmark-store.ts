import type { BenchmarkObservation, BenchmarkSnapshot } from "../domain/benchmark.ts";

/** Immutable evidence snapshot boundary. Only complete snapshots become visible. */
export interface BenchmarkStore {
	publish(sourceId: string, snapshotId: string, observations: BenchmarkObservation[]): BenchmarkSnapshot;
	latest(sourceId: string): BenchmarkSnapshot | null;
}
