import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../observability/metric.ts";
import type { DistinctScopesFilter, MetricStore, UsageAggregateFilter } from "../observability/store.ts";
import type { UsageAggregateRow } from "../observability/usage.ts";

export interface ObservationExportStatus {
	enabled: boolean;
	semanticConventions: string;
	queued: number;
	dropped: number;
	exported: number;
	failures: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
}

export interface ObservationExporter {
	enqueue(observation: MetricObservation): void;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
	status(): ObservationExportStatus;
}

export class DisabledObservationExporter implements ObservationExporter {
	enqueue(): void {}
	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}
	status(): ObservationExportStatus {
		return {
			enabled: false,
			semanticConventions: "none",
			queued: 0,
			dropped: 0,
			exported: 0,
			failures: 0,
			lastSuccessAt: null,
			lastFailureAt: null,
		};
	}
}

/** Local persistence completes first; exporter enqueue is best-effort and can never alter that result. */
export class ExportingMetricStore implements MetricStore {
	constructor(
		private readonly local: MetricStore,
		private readonly exporter: ObservationExporter,
	) {}

	record(observation: MetricObservation): StoredMetricObservation {
		const stored = this.local.record(observation);
		try {
			this.exporter.enqueue(observation);
		} catch {}
		return stored;
	}

	recordBatch(observations: MetricObservation[]): StoredMetricObservation[] {
		const stored = this.local.recordBatch(observations);
		for (const observation of observations) {
			try {
				this.exporter.enqueue(observation);
			} catch {}
		}
		return stored;
	}

	query(filter?: MetricQuery): StoredMetricObservation[] {
		return this.local.query(filter);
	}
	distinctScopes(filter: DistinctScopesFilter): string[] {
		return this.local.distinctScopes(filter);
	}
	aggregateUsage(filter: UsageAggregateFilter): UsageAggregateRow[] {
		return this.local.aggregateUsage(filter);
	}
	pruneBefore(cutoff: number): number {
		return this.local.pruneBefore(cutoff);
	}
	checkpoint(): void {
		this.local.checkpoint();
	}
	close(): void {
		this.local.close();
	}
}
