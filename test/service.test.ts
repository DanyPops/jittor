import { describe, expect, it } from "bun:test";
import { JittorClient } from "../src/client.ts";
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/domain/metric.ts";
import { usageBucketIndex, type UsageAggregateRow, type UsageBucketWindow } from "../src/domain/usage.ts";
import type { MetricStore, UsageAggregateFilter } from "../src/ports/metric-store.ts";
import { EXPECTED_OPERATION_NAMES, JittorService, createApp } from "../src/service.ts";

class FakeMetricStore implements MetricStore {
	private sequence = 0;
	readonly rows: StoredMetricObservation[] = [];
	record(observation: MetricObservation): StoredMetricObservation {
		const stored = { ...structuredClone(observation), attributes: observation.attributes ?? {}, id: ++this.sequence };
		this.rows.push(stored);
		return structuredClone(stored);
	}
	query(filter: MetricQuery = {}): StoredMetricObservation[] {
		return this.rows.filter((row) => !filter.source || row.source === filter.source).map((row) => structuredClone(row));
	}
	distinctScopes(filter: { source: string; since: number; until: number; limit: number }): string[] {
		return [...new Set(this.rows.filter((row) => row.source === filter.source && row.observedAt >= filter.since && row.observedAt <= filter.until).map((row) => row.scope))].sort().slice(0, filter.limit);
	}
	aggregateUsage(filter: UsageAggregateFilter): UsageAggregateRow[] {
		const window: UsageBucketWindow = { start: filter.since, end: filter.until, bucketCount: filter.bucketCount, bucketSizeMs: filter.bucketSizeMs };
		const sums = new Map<string, UsageAggregateRow>();
		for (const row of this.rows) {
			if (row.source !== filter.source || !filter.scopes.includes(row.scope)) continue;
			if (row.observedAt < filter.since || row.observedAt > filter.until) continue;
			if (typeof row.value !== "number" || row.value < 0) continue;
			const bucketIndex = usageBucketIndex(row.observedAt, window);
			const key = `${row.scope}\u0000${row.metric}\u0000${bucketIndex}`;
			const existing = sums.get(key);
			if (existing) existing.sum += row.value;
			else sums.set(key, { scope: row.scope, metric: row.metric, bucketIndex, sum: row.value });
		}
		return [...sums.values()];
	}
	pruneBefore(cutoff: number): number {
		const before = this.rows.length;
		for (let index = this.rows.length - 1; index >= 0; index--) if (this.rows[index]!.observedAt < cutoff) this.rows.splice(index, 1);
		return before - this.rows.length;
	}
	checkpoint(): void {}
	close(): void {}
}

function request(app: { fetch(request: Request): Promise<Response> }, body: unknown, token = "test-token") {
	return app.fetch(new Request("http://jittor.test/api/v1/ops", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
}

describe("Jittor operation service", () => {
	it("depends only on the metric-store port and registers stable operations", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		expect(service.operationNames()).toEqual([...EXPECTED_OPERATION_NAMES]);
		const recorded = await service.execute("metrics.record", {
			source: "openrouter", scope: "key:default", metric: "cost", value: 0.01,
			unit: "usd", observedAt: 1000,
		}) as StoredMetricObservation;
		expect(recorded.id).toBe(1);
		expect(await service.execute("metrics.query", { source: "openrouter" })).toHaveLength(1);
		const assessment = await service.execute("context.assess", { since: 0, until: 2_000 });
		expect(assessment).toMatchObject({ completeness: "complete", injection: { runs: 0 }, compaction: { completed: 0 } });
		await expect(service.execute("metrics.record", {
			source: "openrouter", scope: "key:default", metric: "cost", value: 1,
			unit: "credits" as never, observedAt: 1000,
		})).rejects.toThrow("unit is not supported");
	});

	it("finds bounded distinct scopes for a source within a time window, fairly surfacing every series", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		await service.execute("metrics.record", { source: "pi", scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 1, unit: "tokens", observedAt: 1_000 });
		await service.execute("metrics.record", { source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 1, unit: "tokens", observedAt: 2_000 });
		expect(await service.execute("metrics.distinct_scopes", { source: "pi", since: 0, until: 5_000 })).toEqual(["anthropic-vertex:claude-sonnet-5", "openai-codex:gpt-5.6-sol"]);
		expect(await service.execute("metrics.distinct_scopes", { source: "pi", since: 0, until: 5_000, limit: 1 })).toHaveLength(1);
		await expect(service.execute("metrics.distinct_scopes", { source: "pi", since: 5_000, until: 0 })).rejects.toThrow("ordered integer bounds");
		await expect(service.execute("metrics.distinct_scopes", { since: 0, until: 5_000 })).rejects.toThrow("source is required");
		// A generously large requested limit is still clamped server-side, not trusted from the client.
		expect(await service.execute("metrics.distinct_scopes", { source: "pi", since: 0, until: 5_000, limit: 999_999 })).toHaveLength(2);
	});

	it("aggregates usage server-side instead of returning raw rows, so a heavy scope's full history always fits", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		// Two rows, same scope+metric, same bucket -- must be summed server-side, never handed back raw.
		await service.execute("metrics.record", { source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 100, unit: "tokens", observedAt: 1_000 });
		await service.execute("metrics.record", { source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 50, unit: "tokens", observedAt: 1_500 });
		// A later row landing in the next bucket must not bleed into the first.
		await service.execute("metrics.record", { source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 999, unit: "tokens", observedAt: 6_000 });

		const result = await service.execute("metrics.usage_series", {
			source: "pi", since: 0, until: 10_000, bucketSizeMs: 5_000, bucketCount: 2,
		}) as { rows: unknown[]; truncated: boolean };
		expect(result.truncated).toBe(false);
		expect(result.rows).toEqual([
			{ scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", bucketIndex: 0, sum: 150 },
			{ scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", bucketIndex: 1, sum: 999 },
		]);

		// A scope-discovery cap that's actually exceeded is still honestly reported as truncated.
		await service.execute("metrics.record", { source: "pi", scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 1, unit: "tokens", observedAt: 1_000 });
		const capped = await service.execute("metrics.usage_series", {
			source: "pi", since: 0, until: 10_000, bucketSizeMs: 5_000, bucketCount: 2, scopeLimit: 1,
		}) as { rows: unknown[]; truncated: boolean };
		expect(capped.truncated).toBe(true);

		await expect(service.execute("metrics.usage_series", { source: "pi", since: 0, until: 10_000, bucketSizeMs: 0, bucketCount: 2 })).rejects.toThrow("bucketSizeMs must be a positive number");
		await expect(service.execute("metrics.usage_series", { source: "pi", since: 0, until: 10_000, bucketSizeMs: 5_000, bucketCount: 0 })).rejects.toThrow("bucketCount must be a positive integer");
		await expect(service.execute("metrics.usage_series", { since: 0, until: 10_000, bucketSizeMs: 5_000, bucketCount: 2 })).rejects.toThrow("source is required");
	});

	it("refuses to prune metrics newer than the safety window unless force is set, but always allows genuinely old cutoffs", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		await expect(service.execute("metrics.prune", { before: longAgo })).resolves.toEqual({ deleted: 0 });
		const tooRecent = Date.now() - 1_000;
		await expect(service.execute("metrics.prune", { before: tooRecent })).rejects.toThrow("refusing to prune metrics newer than");
		await expect(service.execute("metrics.prune", { before: tooRecent, force: true })).resolves.toEqual({ deleted: 0 });
	});

	it("sums cost/token metrics by focused task, keeping unattributed spend visible and never dropped", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		await service.execute("metrics.record", { source: "pi", scope: "anthropic:claude-sonnet-5", metric: "cost", value: 0.05, unit: "usd", observedAt: 1_000, attributes: { taskId: "ship-feature-x" } });
		await service.execute("metrics.record", { source: "pi", scope: "anthropic:claude-sonnet-5", metric: "cost", value: 0.02, unit: "usd", observedAt: 1_500, attributes: {} });
		const summary = await service.execute("metrics.cost_by_task", { since: 0, until: 5_000 });
		expect(summary).toMatchObject({ entries: [{ taskId: "ship-feature-x", costUsd: 0.05 }], unattributedCostUsd: 0.02, truncated: false });
		await expect(service.execute("metrics.cost_by_task", { since: 5_000, until: 0 })).rejects.toThrow("ordered integer bounds");
	});

	it("learns a compaction duration estimate from recorded pi-context compaction-duration metrics", async () => {
		const store = new FakeMetricStore();
		const service = new JittorService(store);
		expect(await service.execute("compaction.estimate", {})).toMatchObject({ ms: null, confidence: "cold-start", sampleSize: 0 });
		for (const [index, durationMs] of [4_000, 4_200, 3_900].entries()) {
			await service.execute("metrics.record", {
				source: "pi-context", scope: "compaction", metric: "compaction-duration", value: durationMs,
				unit: "milliseconds", observedAt: 1_000 + index,
			});
		}
		expect(await service.execute("compaction.estimate", {})).toMatchObject({ ms: 4_000, confidence: "learned", sampleSize: 3 });
	});

	it("authenticates the loopback operation endpoint", async () => {
		const service = new JittorService(new FakeMetricStore());
		const app = createApp({ service, token: "test-token" });
		expect((await request(app, { op: "metrics.query", input: {} }, "wrong")).status).toBe(401);
		const response = await request(app, { op: "metrics.record", input: {
			source: "codex-subscription", scope: "primary", metric: "used-fraction", value: 0.5,
			unit: "ratio", observedAt: 1000,
		} });
		expect(response.status).toBe(200);
		expect(((await response.json()) as { result: StoredMetricObservation }).result.id).toBe(1);
	});

	it("provides a typed client over the same transport", async () => {
		const service = new JittorService(new FakeMetricStore());
		const app = createApp({ service, token: "test-token" });
		const client = new JittorClient("http://jittor.test", "test-token", (request) => app.fetch(request));
		await client.call("metrics.record", {
			source: "openrouter", scope: "key:default", metric: "cost", value: 0.03,
			unit: "usd", observedAt: 2000,
		});
		expect(await client.call("metrics.query", { source: "openrouter" })).toHaveLength(1);
		expect(await client.call("context.assess", { since: 0, until: 3_000 })).toMatchObject({ injection: { runs: 0 } });
		expect(await client.operations()).toEqual([...EXPECTED_OPERATION_NAMES]);
	});
});
