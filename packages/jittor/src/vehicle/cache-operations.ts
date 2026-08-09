import { CACHE_ECONOMICS_QUERY_LIMIT } from "../constants.ts";
import {
	buildCacheEconomicsSummary,
	type CacheEconomicsPricing,
	type CacheEconomicsPricingLookup,
} from "../observability/cache-economics.ts";
import type { MetricStore } from "../observability/store.ts";
import type { ModelCatalogController } from "../optimization/model-selection/catalog.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

/**
 * Best-effort catalog-backed pricing lookup: an unconfigured/unavailable catalog, or a model the
 * catalog doesn't carry, returns null rather than throwing -- cache economics degrades that
 * model's pricing to "unknown" instead of failing the whole query.
 *
 * `contextSizeTokens` is accepted (matching the caller-side per-run resolution in
 * cache-economics.ts) but not yet used to resolve `pricing.tiers`/`contextOver200k` -- only the
 * flat top-level prices are returned today. Tiered/long-context resolution is the next slice; this
 * still only returns a flat price so this refactor stays behavior-preserving.
 */
class CatalogCacheEconomicsPricing implements CacheEconomicsPricingLookup {
	constructor(private readonly catalog: ModelCatalogController) {}

	priceFor(provider: string, model: string, _contextSizeTokens: number): CacheEconomicsPricing | null {
		try {
			const entry = this.catalog.query({ provider, model, limit: 1 }).entries[0];
			if (!entry) return null;
			return { input: entry.pricing?.input, cacheRead: entry.pricing?.cacheRead, cacheWrite: entry.pricing?.cacheWrite };
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
