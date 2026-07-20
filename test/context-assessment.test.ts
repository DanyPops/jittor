import { describe, expect, it } from "bun:test";
import { assessContextTelemetry } from "../src/domain/context-telemetry.ts";
import type { StoredMetricObservation } from "../src/domain/metric.ts";

function row(id: number, source: string, metric: string, value: number, unit: StoredMetricObservation["unit"], observedAt: number, attributes: Record<string, unknown> = {}): StoredMetricObservation {
	return { id, source, scope: source === "papyrus-context" ? "system-prompt" : "compaction", metric, value, unit, observedAt, attributes };
}

describe("context pressure assessment", () => {
	it("summarizes bounded injection, compaction, and provider/cache facts", () => {
		const result = assessContextTelemetry([
			row(1, "papyrus-context", "injected-characters", 100, "count", 1_000, { ruleCharacters: 60, taskCharacters: 40, estimatedTokens: 25, share: 0.1, unchanged: false }),
			row(2, "papyrus-context", "injected-characters", 300, "count", 2_000, { ruleCharacters: 100, taskCharacters: 200, estimatedTokens: 75, share: 0.3, unchanged: true }),
		], [
			row(3, "pi-context", "compaction-duration", 500, "milliseconds", 3_000, { reason: "threshold", turnsSincePrevious: 4, elapsedSincePreviousMs: 2_000, providerTokensSincePrevious: 2_500, cacheReadTokensSincePrevious: 1_000 }),
			row(4, "pi-context", "compaction-duration", 1_500, "milliseconds", 5_000, { reason: "overflow", turnsSincePrevious: 2, elapsedSincePreviousMs: 2_000, providerTokensSincePrevious: 1_500, cacheReadTokensSincePrevious: 500, willRetry: true }),
			row(5, "pi-context", "compaction-aborted", 1, "count", 6_000, { reason: "manual" }),
		], { since: 1_000, until: 7_000, truncated: false });
		expect(result.injection).toMatchObject({ runs: 2, averageCharacters: 200, p95Characters: 300, maxCharacters: 300, estimatedTokens: 100, unchangedRate: 0.5, averageShare: 0.2, ruleCharacters: 160, taskCharacters: 240 });
		expect(result.compaction).toMatchObject({ completed: 2, aborted: 1, averageDurationMs: 1_000, averageTurnsBetween: 3, averageProviderTokensBetween: 2_000, averageCacheReadTokensBetween: 750 });
		expect(result.compaction.reasons).toEqual({ threshold: 1, overflow: 1, manual: 0 });
		expect(result.compaction.perRun).toBe(1);
		expect(result.compaction.perTurn).toBeCloseTo(1 / 3);
		expect(result.completeness).toBe("complete");
	});

	it("reports empty, unknown, and truncated data without inventing zero-cost conclusions", () => {
		const empty = assessContextTelemetry([], [], { since: 0, until: 1_000, truncated: false });
		expect(empty.injection.runs).toBe(0);
		expect(empty.injection.averageCharacters).toBeNull();
		expect(empty.compaction.perHour).toBeNull();
		expect(assessContextTelemetry([], [], { since: 0, until: 1_000, truncated: true }).completeness).toBe("truncated");
	});
});
