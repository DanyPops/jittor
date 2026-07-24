import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMetricStore } from "../src/adapters/sqlite-metric-store.ts";
import { openJittorDb } from "../src/db.ts";

const stores: SQLiteMetricStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function fixture() {
	const path = join(mkdtempSync(join(tmpdir(), "jittor-db-")), "jittor.db");
	const db = openJittorDb(path);
	const store = new SQLiteMetricStore(db);
	stores.push(store);
	return { db, store };
}

describe("SQLite metric store", () => {
	it("migrates an indexed WAL time-series schema", () => {
		const { db } = fixture();
		expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
		expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
		const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metric_observations'").all() as Array<{ name: string }>;
		expect(indexes.map((row) => row.name)).toContain("metric_observations_series_time_idx");
	});

	it("records and queries observations in chronological order", () => {
		const { store } = fixture();
		store.record({
			source: "openrouter", scope: "key:default", metric: "cost", value: 0.2, unit: "usd",
			observedAt: 2000, attributes: { model: "openai/gpt-4.1-mini" },
		});
		store.record({
			source: "openrouter", scope: "key:default", metric: "cost", value: 0.1, unit: "usd",
			observedAt: 1000, attributes: { model: "openai/gpt-4.1-mini" },
		});

		const observations = store.query({ source: "openrouter", scope: "key:default", metric: "cost" });
		expect(observations.map((observation) => observation.value)).toEqual([0.1, 0.2]);
		expect(observations[0]?.attributes).toEqual({ model: "openai/gpt-4.1-mini" });
		expect(observations.every((observation) => typeof observation.id === "number")).toBe(true);
	});

	it("finds distinct scopes for a source within a time window, bounded and alphabetically ordered", () => {
		const { store } = fixture();
		store.record({ source: "pi", scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 100, unit: "tokens", observedAt: 1_000 });
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 200, unit: "tokens", observedAt: 2_000 });
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "output-tokens", value: 50, unit: "tokens", observedAt: 2_500 });
		store.record({ source: "pi", scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 999, unit: "tokens", observedAt: 10_000 });
		store.record({ source: "openrouter", scope: "key:default", metric: "cost", value: 0.1, unit: "usd", observedAt: 2_000 });

		expect(store.distinctScopes({ source: "pi", since: 0, until: 5_000, limit: 40 })).toEqual(["anthropic-vertex:claude-sonnet-5", "openai-codex:gpt-5.6-sol"]);
		expect(store.distinctScopes({ source: "pi", since: 0, until: 5_000, limit: 1 })).toHaveLength(1);
		expect(store.distinctScopes({ source: "pi", since: 20_000, until: 30_000, limit: 40 })).toEqual([]);
	});

	it("aggregates usage into (scope, metric, bucket) sums instead of returning raw rows", () => {
		const { store } = fixture();
		// Two rows for the same scope+metric landing in the same bucket must be summed, not returned
		// as separate rows -- that is the entire point of aggregating in SQL.
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 100, unit: "tokens", observedAt: 1_000 });
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 50, unit: "tokens", observedAt: 1_500 });
		// A different metric, same scope and bucket -- must not be folded into the same sum.
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "output-tokens", value: 10, unit: "tokens", observedAt: 1_200 });
		// A later timestamp landing in the next bucket -- must not bleed into bucket 0.
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 999, unit: "tokens", observedAt: 5_500 });
		// A scope not included in the filter's bounded scope list -- must never appear in the result.
		store.record({ source: "pi", scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 777, unit: "tokens", observedAt: 1_000 });
		// A negative value -- must be excluded, matching every other consumer's non-negative filter.
		store.record({ source: "pi", scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: -5, unit: "tokens", observedAt: 1_000 });

		const rows = store.aggregateUsage({
			source: "pi", scopes: ["anthropic-vertex:claude-sonnet-5"], since: 0, until: 10_000, bucketSizeMs: 5_000, bucketCount: 2,
		});

		expect(rows.sort((left, right) => left.metric.localeCompare(right.metric) || left.bucketIndex - right.bucketIndex)).toEqual([
			{ scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", bucketIndex: 0, sum: 150 },
			{ scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", bucketIndex: 1, sum: 999 },
			{ scope: "anthropic-vertex:claude-sonnet-5", metric: "output-tokens", bucketIndex: 0, sum: 10 },
		]);
	});

	it("aggregates a heavy scope's full history exactly, not just a recent tail (the real incident this replaced)", () => {
		// Directly reproduces what a per-scope-row-capped fetch got wrong: many more observations
		// than any reasonable row limit, spread across the whole window. Every bucket must still carry
		// its real sum -- aggregation has no row-count-based failure mode to silently truncate this.
		const { store } = fixture();
		const scope = "anthropic-vertex:claude-sonnet-5";
		const totalRows = 2_000;
		const windowMs = 7 * 24 * 60 * 60 * 1_000;
		for (let index = 0; index < totalRows; index += 1) {
			store.record({ source: "pi", scope, metric: "input-tokens", value: 10, unit: "tokens", observedAt: Math.floor((index / totalRows) * windowMs) });
		}

		const bucketCount = 28;
		const rows = store.aggregateUsage({ source: "pi", scopes: [scope], since: 0, until: windowMs, bucketSizeMs: windowMs / bucketCount, bucketCount });

		expect(rows.reduce((sum, row) => sum + row.sum, 0)).toBe(totalRows * 10);
		// Every one of the 28 buckets received some of the 2,000 evenly-spread rows -- none silently empty.
		expect(new Set(rows.map((row) => row.bucketIndex)).size).toBe(bucketCount);
	});

	it("prunes only observations older than the cutoff", () => {
		const { store } = fixture();
		for (const observedAt of [1000, 2000, 3000]) {
			store.record({ source: "codex-subscription", scope: "primary", metric: "used-fraction", value: observedAt / 10_000, unit: "ratio", observedAt });
		}
		expect(store.pruneBefore(2000)).toBe(1);
		expect(store.query({ source: "codex-subscription" }).map((row) => row.observedAt)).toEqual([2000, 3000]);
	});
});
