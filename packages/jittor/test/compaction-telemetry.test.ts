import { describe, expect, it } from "bun:test";
import { CompactionTelemetry, estimateCompactionDuration } from "../src/domain/context-telemetry.ts";
import { COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES } from "../src/constants.ts";
import type { StoredMetricObservation } from "../src/domain/metric.ts";

function durationRow(value: number, observedAt: number, id: number, attributes: Record<string, unknown> = {}): StoredMetricObservation {
	return { source: "pi-context", scope: "compaction", metric: "compaction-duration", value, unit: "milliseconds", observedAt, id, attributes };
}

describe("Pi compaction telemetry", () => {
	it("records completed threshold, manual, and overflow compactions with intervals", () => {
		const telemetry = new CompactionTelemetry();
		telemetry.observeTurn();
		telemetry.observeTurn();
		telemetry.observeInjection(400, 100);
		telemetry.observeProviderUsage({ input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 100 });
		const started = telemetry.begin({ reason: "threshold", willRetry: false, contextPercent: 91 }, 1_000);
		expect(started.metric).toBe("compaction-started");
		const completed = telemetry.complete({ reason: "threshold", willRetry: false }, 2_500);
		expect(completed).toMatchObject({ metric: "compaction-duration", value: 1_500, unit: "milliseconds" });
		expect(completed.attributes).toMatchObject({
			reason: "threshold", willRetry: false, turnsSincePrevious: 2,
			injectedCharactersSincePrevious: 400, estimatedInjectedTokensSincePrevious: 100,
			providerTokensSincePrevious: 2_500, cacheReadTokensSincePrevious: 1_000,
		});

		telemetry.begin({ reason: "manual", willRetry: false }, 4_000);
		expect(telemetry.complete({ reason: "manual", willRetry: false }, 4_500).attributes?.reason).toBe("manual");
		telemetry.begin({ reason: "overflow", willRetry: true }, 5_000);
		expect(telemetry.complete({ reason: "overflow", willRetry: true }, 5_250).attributes).toMatchObject({ reason: "overflow", willRetry: true });
	});

	it("keeps aborted and unfinished compactions distinct from success", () => {
		const telemetry = new CompactionTelemetry();
		expect(telemetry.complete({ reason: "manual", willRetry: false }, 1_000)).toMatchObject({ metric: "compaction-unmatched", value: 1 });
		telemetry.begin({ reason: "threshold", willRetry: false }, 2_000);
		const aborted = telemetry.abort(2_200, "session-shutdown");
		expect(aborted).toMatchObject({ metric: "compaction-aborted", value: 1 });
		expect(aborted.attributes).toMatchObject({ reason: "threshold", abortReason: "session-shutdown", durationMs: 200 });
	});
});

describe("Compaction duration estimate", () => {
	it("reports explicit cold-start uncertainty below the minimum sample size", () => {
		expect(estimateCompactionDuration([], 1_000)).toEqual({ ms: null, confidence: "cold-start", sampleSize: 0, observedAt: 1_000 });
		const two = [durationRow(4_000, 100, 1), durationRow(4_200, 200, 2)];
		expect(estimateCompactionDuration(two, 1_000)).toEqual({ ms: null, confidence: "cold-start", sampleSize: 2, observedAt: 1_000 });
	});

	it("learns a median estimate once enough samples are present, most recent first", () => {
		const rows = [durationRow(4_000, 100, 1), durationRow(4_200, 200, 2), durationRow(3_900, 300, 3)];
		const estimate = estimateCompactionDuration(rows, 1_000);
		expect(estimate).toEqual({ ms: 4_000, confidence: "learned", sampleSize: 3, observedAt: 1_000 });
	});

	it("bounds retention to the most recent COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES regardless of how many rows are supplied", () => {
		const rows: StoredMetricObservation[] = [];
		for (let index = 0; index < COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES + 50; index += 1) {
			// Old rows carry a huge outlier value; only the most recent MAX_SAMPLES rows (small values) should count.
			rows.push(durationRow(index < 50 ? 999_000 : 4_000, index, index));
		}
		const estimate = estimateCompactionDuration(rows, 1_000_000);
		expect(estimate.sampleSize).toBe(COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES);
		expect(estimate.ms).toBe(4_000);
	});

	it("skips invalid persisted rows (wrong source/scope/metric, non-numeric, or negative values) without throwing", () => {
		const rows: StoredMetricObservation[] = [
			durationRow(4_000, 100, 1),
			durationRow(4_100, 200, 2),
			durationRow(3_900, 300, 3),
			{ source: "pi-context", scope: "compaction", metric: "compaction-duration", value: null, unit: "milliseconds", observedAt: 400, id: 4, attributes: {} },
			{ source: "pi-context", scope: "compaction", metric: "compaction-duration", value: -500, unit: "milliseconds", observedAt: 500, id: 5, attributes: {} },
			{ source: "pi-context", scope: "compaction", metric: "compaction-aborted", value: 1, unit: "count", observedAt: 600, id: 6, attributes: {} },
			{ source: "openrouter", scope: "compaction", metric: "compaction-duration", value: 4_500, unit: "milliseconds", observedAt: 700, id: 7, attributes: {} },
		];
		expect(() => estimateCompactionDuration(rows, 1_000)).not.toThrow();
		const estimate = estimateCompactionDuration(rows, 1_000);
		expect(estimate).toEqual({ ms: 4_000, confidence: "learned", sampleSize: 3, observedAt: 1_000 });
	});

	it("never reflects transcript content or credential-shaped attributes, since only the numeric value is read", () => {
		const rows = [
			durationRow(4_000, 100, 1, { transcript: "sensitive user prompt content", apiKey: "sk-should-never-leak" }),
			durationRow(4_100, 200, 2),
			durationRow(3_900, 300, 3),
		];
		const estimate = estimateCompactionDuration(rows, 1_000);
		expect(JSON.stringify(estimate)).not.toContain("transcript");
		expect(JSON.stringify(estimate)).not.toContain("sk-should-never-leak");
	});

	it("reduces forecast error versus a naive last-value baseline on the same synthetic workload with an outlier", () => {
		// Control: predict the next duration as "whatever the most recent single sample was".
		// Candidate: predict the next duration as the median of the last MIN_SAMPLES..MAX_SAMPLES rolling window.
		const durations = [4_000, 4_200, 3_900, 4_100, 15_000, 4_050, 3_950, 4_300, 4_000, 4_150];
		let medianSquaredError = 0;
		let naiveSquaredError = 0;
		let comparisons = 0;
		for (let index = 3; index < durations.length; index += 1) {
			const priorRows = durations.slice(0, index).map((value, sampleIndex) => durationRow(value, sampleIndex, sampleIndex));
			const actual = durations[index]!;
			const estimate = estimateCompactionDuration(priorRows, index);
			const naiveGuess = durations[index - 1]!;
			if (estimate.ms !== null) {
				medianSquaredError += (estimate.ms - actual) ** 2;
				naiveSquaredError += (naiveGuess - actual) ** 2;
				comparisons += 1;
			}
		}
		expect(comparisons).toBeGreaterThan(0);
		expect(medianSquaredError).toBeLessThan(naiveSquaredError);
	});
});
