export type TelemetryFreshness = "fresh" | "stale" | "failed";

export interface BudgetWindow {
	id: string;
	source: string;
	scope: string;
	usedFraction: number;
	windowSeconds: number;
	resetsAt: number;
	observedAt: number;
	freshness: TelemetryFreshness;
	confidence: number;
	observedBurnPerSecond?: number;
}
