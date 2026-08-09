import { describe, expect, it } from "bun:test";
import {
	buildCacheEconomicsSummary,
	type CacheEconomicsPricing,
	type CacheEconomicsPricingLookup,
} from "../src/observability/cache-economics.ts";
import type { StoredMetricObservation } from "../src/observability/metric.ts";

let nextId = 1;

function usageRow(
	overrides: Partial<StoredMetricObservation> & { observedAt: number; metric: string; value: number },
): StoredMetricObservation {
	return {
		id: nextId++,
		source: "pi",
		scope: "anthropic:claude-sonnet-5",
		unit: "tokens",
		attributes: { provider: "anthropic", model: "claude-sonnet-5", sessionId: "session-1" },
		...overrides,
	};
}

function snapshotHeaderRow(overrides: Partial<StoredMetricObservation> & { observedAt: number; scope: string }): StoredMetricObservation {
	return {
		id: nextId++,
		source: "pi-context-snapshot",
		metric: "snapshot",
		value: 0,
		unit: "tokens",
		attributes: { resetReason: null },
		...overrides,
	};
}

class FakePricing implements CacheEconomicsPricingLookup {
	constructor(private readonly table: Record<string, CacheEconomicsPricing>) {}
	priceFor(provider: string, model: string, _contextSizeTokens: number): CacheEconomicsPricing | null {
		return this.table[`${provider}/${model}`] ?? null;
	}
}

const noPricing = new FakePricing({});

describe("cache economics", () => {
	it("derives cache-read savings and cache-write premium entirely from provider-reported cost, never touching the catalog", () => {
		const rows = [
			usageRow({ observedAt: 1_000, metric: "input-tokens", value: 1_000_000 }),
			usageRow({ observedAt: 1_000, metric: "input-cost", unit: "usd", value: 3 }), // $3 / 1M input tokens => rate 0.000003/token
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 500_000 }),
			usageRow({ observedAt: 1_000, metric: "cache-read-cost", unit: "usd", value: 0.15 }), // actually billed at $0.3/1M
			usageRow({ observedAt: 1_000, metric: "cache-write-tokens", value: 200_000 }),
			usageRow({ observedAt: 1_000, metric: "cache-write-cost", unit: "usd", value: 0.75 }), // actually billed at $3.75/1M
		];
		const summary = buildCacheEconomicsSummary(rows, [], noPricing, { since: 0, until: 2_000 });
		expect(summary.models).toHaveLength(1);
		const model = summary.models[0]!;
		expect(model).toMatchObject({
			provider: "anthropic",
			model: "claude-sonnet-5",
			inputTokens: 1_000_000,
			cacheReadTokens: 500_000,
			cacheWriteTokens: 200_000,
			cacheReadCostUsd: 0.15,
			cacheReadCostBasis: "provider-reported",
			cacheWriteCostUsd: 0.75,
			cacheWriteCostBasis: "provider-reported",
			effectiveInputRateUsdPerToken: 0.000003,
		});
		// Counterfactual: 500,000 tokens at the observed input rate (0.000003/token) = $1.5
		expect(model.counterfactualNoCacheCostUsd).toBeCloseTo(1.5, 10);
		expect(model.counterfactualBasis).toBe("provider-reported");
		// Savings: 1.5 (would-have-cost) - 0.15 (actually paid) = 1.35
		expect(model.savingsUsd).toBeCloseTo(1.35, 10);
		// Write premium: 0.75 actually paid - (200,000 * 0.000003 = 0.6 at plain input rate) = 0.15
		expect(model.cacheWritePremiumUsd).toBeCloseTo(0.15, 10);
		expect(model.paybackAchieved).toBe(true);
		expect(model.breakEvenReadTokens).not.toBeNull();
	});

	it("falls back to catalog-estimate pricing, clearly labeled, when the provider does not itemize cache cost", () => {
		const rows = [
			usageRow({ observedAt: 1_000, metric: "input-tokens", value: 1_000_000 }),
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 500_000 }),
			usageRow({ observedAt: 1_000, metric: "cache-write-tokens", value: 200_000 }),
			// No input-cost/cache-read-cost/cache-write-cost rows at all -- provider never reported them.
		];
		const pricing = new FakePricing({ "anthropic/claude-sonnet-5": { input: 3, cacheRead: 0.3, cacheWrite: 3.75 } });
		const summary = buildCacheEconomicsSummary(rows, [], pricing, { since: 0, until: 2_000 });
		const model = summary.models[0]!;
		expect(model.cacheReadCostBasis).toBe("catalog-estimate");
		expect(model.cacheReadCostUsd).toBeCloseTo(0.15, 10);
		expect(model.cacheWriteCostBasis).toBe("catalog-estimate");
		expect(model.cacheWriteCostUsd).toBeCloseTo(0.75, 10);
		expect(model.counterfactualBasis).toBe("catalog-estimate");
	});

	it("keeps unknown fields unknown for a no-cache provider with neither provider-reported nor catalog pricing", () => {
		const rows = [
			usageRow({ observedAt: 1_000, metric: "input-tokens", value: 1_000 }),
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 0 }),
			usageRow({ observedAt: 1_000, metric: "cache-write-tokens", value: 0 }),
		];
		const summary = buildCacheEconomicsSummary(rows, [], noPricing, { since: 0, until: 2_000 });
		const model = summary.models[0]!;
		expect(model.cacheReadTokens).toBe(0);
		expect(model.cacheWriteTokens).toBe(0);
		// Zero cache activity is a trivial, known fact (zero tokens cost zero dollars) -- not an estimate.
		expect(model.cacheReadCostUsd).toBe(0);
		expect(model.cacheReadCostBasis).toBe("provider-reported");
		expect(model.cacheWriteCostUsd).toBe(0);
		// No write happened, so "was the write premium paid back" does not apply.
		expect(model.paybackAchieved).toBeNull();
		expect(model.breakEvenReadTokens).toBe(0);
	});

	it("reports unknown, not a fabricated number, when cache activity exists but no pricing evidence of any kind is available", () => {
		const rows = [
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 500_000 }),
			usageRow({ observedAt: 1_000, metric: "cache-write-tokens", value: 200_000 }),
		];
		const summary = buildCacheEconomicsSummary(rows, [], noPricing, { since: 0, until: 2_000 });
		const model = summary.models[0]!;
		expect(model.cacheReadCostUsd).toBeNull();
		expect(model.cacheReadCostBasis).toBe("unknown");
		expect(model.cacheWriteCostUsd).toBeNull();
		expect(model.cacheWriteCostBasis).toBe("unknown");
		expect(model.counterfactualNoCacheCostUsd).toBeNull();
		expect(model.savingsUsd).toBeNull();
		expect(model.cacheWritePremiumUsd).toBeNull();
		expect(model.paybackAchieved).toBeNull();
		expect(model.breakEvenReadTokens).toBeNull();
	});

	it("isolates economics per provider/model, since pricing and cache behavior differ by model", () => {
		const rows = [
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 1_000 }),
			usageRow({
				observedAt: 1_000,
				metric: "cache-read-tokens",
				value: 4_000,
				scope: "openrouter:openai/gpt-4.1-mini",
				attributes: { provider: "openrouter", model: "openai/gpt-4.1-mini", sessionId: "session-1" },
			}),
		];
		const summary = buildCacheEconomicsSummary(rows, [], noPricing, { since: 0, until: 2_000 });
		expect(summary.models).toHaveLength(2);
		expect(summary.models.map((model) => model.cacheReadTokens).sort()).toEqual([1_000, 4_000]);
	});

	it("falls back to an unknown/unknown model bucket for rows recorded before provider/model attribution existed, rather than dropping them", () => {
		const rows = [usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 10, attributes: {} })];
		const summary = buildCacheEconomicsSummary(rows, [], noPricing, { since: 0, until: 2_000 });
		expect(summary.models[0]).toMatchObject({ provider: "unknown", model: "unknown", cacheReadTokens: 10 });
	});

	it("ignores rows outside the requested window and from other sources", () => {
		const rows = [
			usageRow({ observedAt: 500, metric: "cache-read-tokens", value: 999 }), // before window
			usageRow({ observedAt: 3_000, metric: "cache-read-tokens", value: 999 }), // after window
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 1, source: "local-model" }), // wrong source
			usageRow({ observedAt: 1_000, metric: "cache-read-tokens", value: 42 }),
		];
		const summary = buildCacheEconomicsSummary(rows, [], noPricing, { since: 1_000, until: 2_000 });
		expect(summary.models).toHaveLength(1);
		expect(summary.models[0]!.cacheReadTokens).toBe(42);
	});

	it("flags a candidate missed-cache opportunity when a context-prefix reset is followed shortly by a same-session cache write, without asserting causality", () => {
		const resetRow = snapshotHeaderRow({ observedAt: 1_000, scope: "session-1", attributes: { resetReason: "model-changed" } });
		const write = usageRow({
			observedAt: 31_000,
			metric: "cache-write-tokens",
			value: 50_000,
			attributes: { provider: "anthropic", model: "claude-sonnet-5", sessionId: "session-1" },
		});
		const summary = buildCacheEconomicsSummary([write], [resetRow], noPricing, { since: 0, until: 2_000_000 });
		expect(summary.missedOpportunities).toHaveLength(1);
		expect(summary.missedOpportunities[0]).toMatchObject({
			sessionId: "session-1",
			resetReason: "model-changed",
			cacheWriteTokens: 50_000,
		});
		expect(summary.missedOpportunities[0]!.note).toMatch(/candidate/i);
	});

	it("does not flag a missed-cache candidate for an unrelated session, or a write far outside the correlation window", () => {
		const resetRow = snapshotHeaderRow({ observedAt: 1_000, scope: "session-1", attributes: { resetReason: "provider-changed" } });
		const otherSessionWrite = usageRow({
			observedAt: 31_000,
			metric: "cache-write-tokens",
			value: 50_000,
			attributes: { provider: "anthropic", model: "claude-sonnet-5", sessionId: "session-2" },
		});
		const tooLateWrite = usageRow({
			observedAt: 1_000 + 60 * 60_000,
			metric: "cache-write-tokens",
			value: 50_000,
			attributes: { provider: "anthropic", model: "claude-sonnet-5", sessionId: "session-1" },
		});
		const summary = buildCacheEconomicsSummary([otherSessionWrite, tooLateWrite], [resetRow], noPricing, {
			since: 0,
			until: 10_000_000,
		});
		expect(summary.missedOpportunities).toHaveLength(0);
	});

	it("ignores a context snapshot whose reset reason is null -- ordinary continuity is not a cache-loss candidate", () => {
		const resetRow = snapshotHeaderRow({ observedAt: 1_000, scope: "session-1", attributes: { resetReason: null } });
		const write = usageRow({
			observedAt: 31_000,
			metric: "cache-write-tokens",
			value: 50_000,
			attributes: { provider: "anthropic", model: "claude-sonnet-5", sessionId: "session-1" },
		});
		const summary = buildCacheEconomicsSummary([write], [resetRow], noPricing, { since: 0, until: 2_000_000 });
		expect(summary.missedOpportunities).toHaveLength(0);
	});

	it("bounds the number of reported missed-cache candidates", () => {
		const resets: StoredMetricObservation[] = [];
		const writes: StoredMetricObservation[] = [];
		for (let index = 0; index < 150; index += 1) {
			const sessionId = `session-${index}`;
			resets.push(snapshotHeaderRow({ observedAt: 1_000, scope: sessionId, attributes: { resetReason: "session-changed" } }));
			writes.push(
				usageRow({
					observedAt: 31_000,
					metric: "cache-write-tokens",
					value: 1,
					attributes: { provider: "anthropic", model: "claude-sonnet-5", sessionId },
				}),
			);
		}
		const summary = buildCacheEconomicsSummary(writes, resets, noPricing, { since: 0, until: 10_000_000 });
		expect(summary.missedOpportunities.length).toBeLessThanOrEqual(100);
		expect(summary.truncated).toBe(true);
	});

	it("reports the requested window and an untruncated result for a normal bounded query", () => {
		const summary = buildCacheEconomicsSummary([], [], noPricing, { since: 10, until: 20 });
		expect(summary).toMatchObject({ since: 10, until: 20, models: [], missedOpportunities: [], truncated: false });
	});
});
