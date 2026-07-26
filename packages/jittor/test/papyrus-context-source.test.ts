import { describe, expect, it } from "bun:test";
import { papyrusContextMetric, validatePapyrusContextInjection } from "../src/domain/context-telemetry.ts";

function payload() {
	return {
		schema: "papyrus.context-injection/v1",
		observedAt: 1_000,
		sequence: 3,
		producerId: "123e4567-e89b-42d3-a456-426614174000",
		before: { characters: 1_000, bytes: 1_100 },
		rules: { characters: 200, bytes: 220, count: 2 },
		tasks: { characters: 300, bytes: 320 },
		injected: { characters: 500, bytes: 540 },
		after: { characters: 1_500, bytes: 1_640 },
		estimatedTokens: 125,
		share: 1 / 3,
		fingerprint: "a".repeat(64),
		unchanged: false,
	};
}

describe("Papyrus context telemetry source", () => {
	it("validates the versioned content-free contract and projects one bounded metric", () => {
		const observation = validatePapyrusContextInjection(payload(), 1_500);
		const metric = papyrusContextMetric(observation);
		expect(metric).toMatchObject({
			source: "papyrus-context", scope: "system-prompt", metric: "injected-characters",
			value: 500, unit: "count", observedAt: 1_000,
		});
		expect(metric.attributes).toMatchObject({
			sequence: 3, producerId: "123e4567-e89b-42d3-a456-426614174000", ruleCharacters: 200, taskCharacters: 300, estimatedTokens: 125,
			share: 1 / 3, unchanged: false, fingerprint: "a".repeat(64),
		});
	});

	it("rejects malformed, stale, oversized, or content-bearing payloads", () => {
		expect(() => validatePapyrusContextInjection({ ...payload(), schema: "v2" }, 1_500)).toThrow("schema");
		expect(() => validatePapyrusContextInjection(payload(), 1_000 + 10 * 60_000)).toThrow("stale");
		expect(() => validatePapyrusContextInjection({ ...payload(), injected: { characters: 20_000_000, bytes: 20_000_000 } }, 1_500)).toThrow("bounded");
		expect(() => validatePapyrusContextInjection({ ...payload(), content: "secret rule body" }, 1_500)).toThrow("unexpected field");
	});
});
