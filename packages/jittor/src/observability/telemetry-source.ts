import type { BudgetWindow } from "./budget.ts";
import type { MetricObservation } from "./metric.ts";

export interface TelemetryBatch {
	observedAt: number;
	metrics: MetricObservation[];
	windows: BudgetWindow[];
}

export interface TelemetrySource {
	id: string;
	provider: string;
	required: boolean;
	poll(): Promise<TelemetryBatch>;
}
