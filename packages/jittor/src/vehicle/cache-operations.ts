import { CACHE_ECONOMICS_QUERY_LIMIT, CATALOG_LONG_CONTEXT_THRESHOLD_TOKENS } from "../constants.ts";
import {
	buildCacheEconomicsSummary,
	type CacheEconomicsPricing,
	type CacheEconomicsPricingLookup,
} from "../observability/cache-economics.ts";
import type { MetricStore } from "../observability/store.ts";
import type { ModelCatalogController, ModelCatalogPriceTier, ModelCatalogPricing } from "../optimization/model-selection/catalog.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

function mergeWithBase(
	base: ModelCatalogPricing,
	override: Partial<Pick<ModelCatalogPricing, "input" | "cacheRead" | "cacheWrite">>,
): CacheEconomicsPricing {
	return {
		input: override.input ?? base.input,
		cacheRead: override.cacheRead ?? base.cacheRead,
		cacheWrite: override.cacheWrite ?? base.cacheWrite,
	};
}

/**
 * Resolves one flat price for one real request size, honoring models.dev's own long-context and
 * tiered pricing shapes -- the only place tiering can be resolved honestly, since it needs a
 * single request's real context size (see cache-economics.ts's per-run pricing).
 *
 * `contextOver200k` takes priority over `tiers` when both are present (mirrors models.dev's own
 * convention: it is a distinct override for the specific >200k-token case, not one more tier).
 * A field a tier/override omits falls back to the base flat price, never to `undefined`-as-unknown
 * silently -- a tier that only republishes input/output pricing still inherits the model's real
 * cache prices instead of losing them.
 */
export function resolveTieredCatalogPrice(pricing: ModelCatalogPricing, contextSizeTokens: number): CacheEconomicsPricing {
	if (pricing.contextOver200k && contextSizeTokens > CATALOG_LONG_CONTEXT_THRESHOLD_TOKENS) {
		return mergeWithBase(pricing, pricing.contextOver200k);
	}
	if (pricing.tiers && pricing.tiers.length > 0) {
		const ascending = [...pricing.tiers].sort((left, right) => left.contextSize - right.contextSize);
		const tier: ModelCatalogPriceTier = ascending.find((candidate) => candidate.contextSize >= contextSizeTokens) ?? ascending.at(-1)!;
		return mergeWithBase(pricing, tier);
	}
	return { input: pricing.input, cacheRead: pricing.cacheRead, cacheWrite: pricing.cacheWrite };
}

/**
 * Best-effort catalog-backed pricing lookup: an unconfigured/unavailable catalog, or a model the
 * catalog doesn't carry, returns null rather than throwing -- cache economics degrades that
 * model's pricing to "unknown" instead of failing the whole query.
 */
class CatalogCacheEconomicsPricing implements CacheEconomicsPricingLookup {
	constructor(private readonly catalog: ModelCatalogController) {}

	priceFor(provider: string, model: string, contextSizeTokens: number): CacheEconomicsPricing | null {
		try {
			const entry = this.catalog.query({ provider, model, limit: 1 }).entries[0];
			if (!entry?.pricing) return null;
			return resolveTieredCatalogPrice(entry.pricing, contextSizeTokens);
		} catch {
			return null;
		}
	}
}

/** cache.economics -- the only operation that combines the metric store's "pi"/"pi-context-snapshot" rows with catalog pricing. */
export function cacheEconomicsOperations(metrics: MetricStore, catalog: ModelCatalogController): OperationHandlerMap {
	const pricing = new CatalogCacheEconomicsPricing(catalog);
	return {
		"cache.economics": (input) => {
			const since = input.since;
			const until = input.until;
			if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || (since as number) < 0 || (until as number) < (since as number)) {
				throw new Error("cache economics requires non-negative ordered integer bounds");
			}
			const usageRows = metrics.query({
				source: "pi",
				since: since as number,
				until: until as number,
				order: "desc",
				limit: CACHE_ECONOMICS_QUERY_LIMIT,
			});
			const snapshotRows = metrics.query({
				source: "pi-context-snapshot",
				metric: "snapshot",
				since: since as number,
				until: until as number,
				order: "desc",
				limit: CACHE_ECONOMICS_QUERY_LIMIT,
			});
			const summary = buildCacheEconomicsSummary(usageRows, snapshotRows, pricing, { since: since as number, until: until as number });
			const rowsTruncated = usageRows.length >= CACHE_ECONOMICS_QUERY_LIMIT || snapshotRows.length >= CACHE_ECONOMICS_QUERY_LIMIT;
			return { ...summary, truncated: summary.truncated || rowsTruncated };
		},
	};
}
