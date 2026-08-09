import { describe, expect, it } from "bun:test";
import { CACHE_ECONOMICS_QUERY_LIMIT } from "../src/constants.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/observability/metric.ts";
import type { UsageAggregateFilter } from "../src/observability/store.ts";
import type { UsageAggregateRow } from "../src/observability/usage.ts";
import type {
	ModelCatalogController,
	ModelCatalogQuery,
	ModelCatalogQueryResult,
	ModelCatalogStatus,
} from "../src/optimization/model-selection/catalog.ts";
import { cacheEconomicsOperations } from "../src/vehicle/cache-operations.ts";

class FakeMetricStore {
	private sequence = 0;
	readonly rows: StoredMetricObservation[] = [];
	record(observation: MetricObservation): StoredMetricObservation {
		const stored = { ...structuredClone(observation), attributes: observation.attributes ?? {}, id: ++this.sequence };
		this.rows.push(stored);
		return structuredClone(stored);
	}
	recordBatch(observations: MetricObservation[]): StoredMetricObservation[] {
		return observations.map((observation) => this.record(observation));
	}
	query(filter: MetricQuery = {}): StoredMetricObservation[] {
		return this.rows
			.filter(
				(row) =>
					(!filter.source || row.source === filter.source) &&
					(!filter.metric || row.metric === filter.metric) &&
					(filter.since === undefined || row.observedAt >= filter.since) &&
					(filter.until === undefined || row.observedAt <= filter.until),
			)
			.slice(0, filter.limit)
			.map((row) => structuredClone(row));
	}
	distinctScopes(): string[] {
		return [];
	}
	aggregateUsage(_filter: UsageAggregateFilter): UsageAggregateRow[] {
		return [];
	}
	pruneBefore(): number {
		return 0;
	}
	checkpoint(): void {}
	close(): void {}
}

class UnavailableCatalog implements ModelCatalogController {
	async refresh(): Promise<ModelCatalogStatus> {
		return this.status();
	}
	status(): ModelCatalogStatus {
		return { configured: false, ok: null, hasSnapshot: false, lastAttemptAt: null, lastSuccessAt: null, entries: 0, revision: null };
	}
	query(): ModelCatalogQueryResult {
		throw new Error("model catalog is not available");
	}
}

class FixtureCatalog implements ModelCatalogController {
	async refresh(): Promise<ModelCatalogStatus> {
		return this.status();
	}
	status(): ModelCatalogStatus {
		return { configured: true, ok: true, hasSnapshot: true, lastAttemptAt: 1, lastSuccessAt: 1, entries: 1, revision: "rev" };
	}
	query(input: ModelCatalogQuery = {}): ModelCatalogQueryResult {
		const matches = input.provider === "anthropic" && input.model === "claude-sonnet-5";
		return {
			snapshotId: "rev",
			provenance: {
				sourceId: "models.dev",
				sourceUrl: "https://models.dev/api.json",
				revision: "rev",
				retrievedAt: 1,
				freshUntil: 2,
				license: "MIT",
			},
			freshness: "fresh",
			completeness: "complete",
			entries: matches
				? [
						{
							provider: "anthropic",
							model: "claude-sonnet-5",
							canonical: "anthropic/claude-sonnet-5",
							aliases: [],
							name: "Claude Sonnet 5",
							status: "active",
							capabilities: { attachment: true, reasoning: true, toolCall: true, structuredOutput: true },
							modalities: { input: ["text"], output: ["text"] },
							limits: { context: 200_000, output: 8_000 },
							pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
							fieldAuthority: {},
						},
					]
				: [],
		};
	}
}

function row(overrides: Partial<StoredMetricObservation> & { observedAt: number; metric: string; value: number }): StoredMetricObservation {
	return {
		id: 0,
		source: "pi",
		scope: "anthropic:claude-sonnet-5",
		unit: "tokens",
		attributes: { provider: "anthropic", model: "claude-sonnet-5" },
		...overrides,
	};
}

describe("cache.economics operation", () => {
	it("rejects unordered or non-integer bounds without touching the store", () => {
		const store = new FakeMetricStore();
		const operations = cacheEconomicsOperations(store, new UnavailableCatalog());
		expect(() => operations["cache.economics"]!({ since: 5_000, until: 0 })).toThrow("ordered integer bounds");
		expect(() => operations["cache.economics"]!({ since: 1.5, until: 5_000 })).toThrow("ordered integer bounds");
	});

	it("degrades to unknown pricing when the catalog is not configured, rather than failing the query", () => {
		const store = new FakeMetricStore();
		store.record(row({ observedAt: 1_000, metric: "cache-read-tokens", value: 100 }));
		const operations = cacheEconomicsOperations(store, new UnavailableCatalog());
		const summary = operations["cache.economics"]!({ since: 0, until: 2_000 }) as { models: Array<Record<string, unknown>> };
		expect(summary.models[0]).toMatchObject({ cacheReadTokens: 100, cacheReadCostBasis: "unknown", cacheReadCostUsd: null });
	});

	it("resolves catalog pricing per model when the provider never itemizes cache cost", () => {
		const store = new FakeMetricStore();
		store.record(row({ observedAt: 1_000, metric: "cache-read-tokens", value: 1_000_000 }));
		const operations = cacheEconomicsOperations(store, new FixtureCatalog());
		const summary = operations["cache.economics"]!({ since: 0, until: 2_000 }) as { models: Array<Record<string, unknown>> };
		expect(summary.models[0]).toMatchObject({ cacheReadCostBasis: "catalog-estimate", cacheReadCostUsd: 0.3 });
	});

	it("reports truncation when the bounded row fetch itself hit its limit, even if the domain summary would not otherwise flag it", () => {
		const store = new FakeMetricStore();
		for (let index = 0; index < CACHE_ECONOMICS_QUERY_LIMIT + 5; index += 1) {
			store.record(row({ observedAt: 1_000, metric: "cache-read-tokens", value: 1 }));
		}
		const operations = cacheEconomicsOperations(store, new UnavailableCatalog());
		const summary = operations["cache.economics"]!({ since: 0, until: 2_000 }) as { truncated: boolean };
		expect(summary.truncated).toBe(true);
	});
});
