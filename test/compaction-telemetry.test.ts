import { describe, expect, it } from "bun:test";
import { CompactionTelemetry } from "../src/domain/context-telemetry.ts";

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
