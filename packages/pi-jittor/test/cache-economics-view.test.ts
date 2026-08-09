import { describe, expect, it } from "bun:test";
import type { CacheEconomicsSummary } from "@danypops/jittor";
import { renderCacheEconomicsView, showCacheEconomicsView } from "../extension/src/observability/cache-economics-view.ts";

function summary(overrides: Partial<CacheEconomicsSummary> = {}): CacheEconomicsSummary {
	return {
		since: 0,
		until: 1_000,
		models: [],
		tasks: [],
		unattributedCacheActivity: {
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheReadCostUsd: 0,
			cacheReadCostBasis: "provider-reported",
			cacheWriteCostUsd: 0,
			cacheWriteCostBasis: "provider-reported",
			catalogFreshness: null,
		},
		missedOpportunities: [],
		truncated: false,
		...overrides,
	};
}

describe("cache economics view", () => {
	it("reports no cache activity plainly when there is none in the window", () => {
		const lines = renderCacheEconomicsView(summary());
		expect(lines.join("\n")).toContain("No cache activity recorded in this window.");
	});

	it("renders each model's read/write tokens, basis-qualified cost, savings, and payback status", () => {
		const lines = renderCacheEconomicsView(
			summary({
				models: [
					{
						provider: "anthropic",
						model: "claude-sonnet-5",
						inputTokens: 1_000_000,
						cacheReadTokens: 500_000,
						cacheWriteTokens: 200_000,
						cacheReadCostUsd: 0.15,
						cacheReadCostBasis: "provider-reported",
						cacheWriteCostUsd: 0.75,
						cacheWriteCostBasis: "catalog-estimate",
						effectiveInputRateUsdPerToken: 0.000003,
						counterfactualNoCacheCostUsd: 1.5,
						counterfactualBasis: "provider-reported",
						savingsUsd: 1.35,
						cacheWritePremiumUsd: 0.15,
						breakEvenReadTokens: 55_556,
						paybackAchieved: true,
						catalogFreshness: "stale",
					},
				],
			}),
		);
		const text = lines.join("\n");
		expect(text).toContain("anthropic/claude-sonnet-5");
		expect(text).toContain("500,000 tok");
		expect(text).toContain("$0.75 (est.)");
		expect(text).toContain("savings $1.35");
		expect(text).toContain("payback yes");
		// The catalog-estimate write cost was resolved from a stale snapshot -- must be visibly distinguishable
		// from a fresh one, not silently identical.
		expect(text).toContain("stale catalog");
	});

	it("renders each task's read/write tokens and payback status, and separately surfaces unattributed activity", () => {
		const lines = renderCacheEconomicsView(
			summary({
				tasks: [
					{
						taskId: "ship-feature-x",
						inputTokens: 1_000_000,
						cacheReadTokens: 500_000,
						cacheWriteTokens: 200_000,
						cacheReadCostUsd: 0.15,
						cacheReadCostBasis: "provider-reported",
						cacheWriteCostUsd: 0.75,
						cacheWriteCostBasis: "provider-reported",
						effectiveInputRateUsdPerToken: 0.000003,
						counterfactualNoCacheCostUsd: 1.5,
						counterfactualBasis: "provider-reported",
						savingsUsd: 1.35,
						cacheWritePremiumUsd: 0.15,
						breakEvenReadTokens: 55_556,
						paybackAchieved: true,
						catalogFreshness: null,
					},
				],
				unattributedCacheActivity: {
					cacheReadTokens: 42,
					cacheWriteTokens: 0,
					cacheReadCostUsd: null,
					cacheReadCostBasis: "unknown",
					cacheWriteCostUsd: 0,
					cacheWriteCostBasis: "provider-reported",
					catalogFreshness: null,
				},
			}),
		);
		const text = lines.join("\n");
		expect(text).toContain("By task: 1");
		expect(text).toContain("ship-feature-x");
		expect(text).toContain("payback yes");
		expect(text).toContain("Unattributed (no task focused)");
		expect(text).toContain("42 tok");
	});

	it("lists candidate missed-cache opportunities without asserting causality", () => {
		const lines = renderCacheEconomicsView(
			summary({
				missedOpportunities: [
					{
						sessionId: "session-1",
						occurredAt: 500,
						resetReason: "model-changed",
						cacheWriteTokens: 50_000,
						cacheWriteCostUsd: 0.75,
						note: "Candidate missed-cache opportunity: correlated, not proven.",
					},
				],
			}),
		);
		const text = lines.join("\n");
		expect(text).toContain("Candidate missed-cache opportunities: 1");
		expect(text).toContain("session session-1");
		expect(text).toContain("model-changed");
	});

	it("flags a truncated result so a user never mistakes a lower bound for the full picture", () => {
		const text = renderCacheEconomicsView(summary({ truncated: true })).join("\n");
		expect(text).toContain("lower bound");
	});

	it("queries the daemon for exactly the requested trailing window and notifies with the rendered summary", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const client = {
			async call(operation: string, input: unknown) {
				calls.push({ operation, input });
				return summary({ since: (input as { since: number }).since, until: (input as { until: number }).until });
			},
		};
		const notifications: string[] = [];
		const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as never;
		await showCacheEconomicsView(ctx, client, 60_000, () => 100_000);
		expect(calls).toEqual([{ operation: "cache.economics", input: { since: 40_000, until: 100_000 } }]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("No cache activity recorded in this window.");
	});
});
