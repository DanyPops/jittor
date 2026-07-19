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

	it("prunes only observations older than the cutoff", () => {
		const { store } = fixture();
		for (const observedAt of [1000, 2000, 3000]) {
			store.record({ source: "codex-subscription", scope: "primary", metric: "used-fraction", value: observedAt / 10_000, unit: "ratio", observedAt });
		}
		expect(store.pruneBefore(2000)).toBe(1);
		expect(store.query({ source: "codex-subscription" }).map((row) => row.observedAt)).toEqual([2000, 3000]);
	});
});
