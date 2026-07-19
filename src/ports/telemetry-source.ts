import type { MetricObservation } from "../domain/metric.ts";
import type { BudgetWindow } from "../policy.ts";

export interface TelemetryBatch {
	observedAt: number;
	metrics: MetricObservation[];
	windows: BudgetWindow[];
}

export interface TelemetrySource {
	id: string;
	required: boolean;
	poll(): Promise<TelemetryBatch>;
}
