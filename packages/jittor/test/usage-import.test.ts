import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.ts";
import { HistoricalUsageImporter } from "../src/observability/usage-import.ts";
import { PiSessionUsageSource } from "../src/pi/session-usage-source.ts";
import { openJittorDb } from "../src/sqlite/database.ts";
import { SQLiteMetricStore } from "../src/sqlite/metric-store.ts";
import { SQLiteUsageImportStore } from "../src/sqlite/usage-import-store.ts";
import { resolveJittorPaths } from "../src/state.ts";
import { connectJittorClient } from "../src/vehicle/client.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "jittor-pi-import-"));
	roots.push(root);
	const sessions = join(root, "sessions", "--project--");
	mkdirSync(sessions, { recursive: true });
	const lines = [
		{
			type: "session",
			version: 3,
			id: "11111111-2222-4333-8444-555555555555",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/private/project",
		},
		{
			type: "model_change",
			id: "a1b2c3d4",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			provider: "anthropic",
			modelId: "claude-sonnet",
		},
		{ type: "thinking_level_change", id: "b2c3d4e5", parentId: "a1b2c3d4", timestamp: "2025-01-01T00:00:02.000Z", thinkingLevel: "high" },
		{
			type: "message",
			id: "c3d4e5f6",
			parentId: "b2c3d4e5",
			timestamp: "2025-01-01T00:00:03.000Z",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-sonnet",
				content: [{ type: "text", text: "private response" }],
				usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, totalTokens: 175, cost: { total: 0.01 } },
				timestamp: 1_735_689_603_000,
			},
		},
		"{truncated",
	];
	writeFileSync(join(sessions, "session.jsonl"), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
	return root;
}

describe("historical Pi usage import", () => {
	it("extracts only supported content-free usage facts across malformed tails", async () => {
		const root = fixtureRoot();
		const source = new PiSessionUsageSource(join(root, "sessions"));
		const scan = await source.scan(() => false);
		expect(scan.records).toHaveLength(1);
		expect(scan.records[0]).toMatchObject({
			provider: "anthropic",
			model: "claude-sonnet",
			thinking: "high",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 50,
			cacheWriteTokens: 5,
			costUsd: 0.01,
		});
		expect(scan.malformedEntries).toBe(1);
		expect(JSON.stringify(scan)).not.toContain("private response");
		expect(JSON.stringify(scan)).not.toContain("/private/project");
	});

	it("imports atomically and remains idempotent across reimport, concurrency, moved files, and restart", async () => {
		const root = fixtureRoot();
		const dbPath = join(root, "jittor.db");
		let db = openJittorDb(dbPath);
		let metrics = new SQLiteMetricStore(db);
		let store = new SQLiteUsageImportStore(db);
		let importer = new HistoricalUsageImporter(new PiSessionUsageSource(join(root, "sessions")), store);
		expect(await importer.run({ dryRun: true })).toMatchObject({ discovered: 1, imported: 0, duplicates: 0, dryRun: true });
		const [first, concurrent] = await Promise.all([importer.run(), importer.run()]);
		expect(first.imported + concurrent.imported).toBe(1);
		renameSync(join(root, "sessions", "--project--"), join(root, "sessions", "--moved-project--"));
		expect((await importer.run()).duplicates).toBe(1);
		const rows = metrics.query({ source: "pi" });
		expect(rows).toHaveLength(5);
		expect(rows.every((row) => row.attributes.imported === true)).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("session.jsonl");
		expect(JSON.stringify(rows)).not.toContain("private response");
		metrics.close();

		db = openJittorDb(dbPath);
		metrics = new SQLiteMetricStore(db);
		store = new SQLiteUsageImportStore(db);
		importer = new HistoricalUsageImporter(new PiSessionUsageSource(join(root, "sessions")), store);
		expect(importer.status().lastResult).toMatchObject({ imported: 0, duplicates: 1 });
		expect((await importer.run()).duplicates).toBe(1);
		metrics.close();
	});

	it("deduplicates a matching live observation instead of double-counting it", async () => {
		const root = fixtureRoot();
		const db = openJittorDb(join(root, "live.db"));
		const metrics = new SQLiteMetricStore(db);
		const source = new PiSessionUsageSource(join(root, "sessions"));
		const record = (await source.scan(() => false)).records[0]!;
		for (const [metric, value, unit] of [
			["input-tokens", 100, "tokens"],
			["output-tokens", 20, "tokens"],
			["cache-read-tokens", 50, "tokens"],
			["cache-write-tokens", 5, "tokens"],
			["cost", 0.01, "usd"],
		] as const) {
			metrics.record({
				source: "pi",
				scope: "anthropic:claude-sonnet",
				metric,
				value,
				unit,
				observedAt: record.observedAt,
			});
		}
		const importer = new HistoricalUsageImporter(source, new SQLiteUsageImportStore(db));
		expect(await importer.run()).toMatchObject({ imported: 0, duplicates: 1 });
		expect(metrics.query({ source: "pi" })).toHaveLength(5);
		metrics.close();
	});

	it("provides dry-run, import, status, and reimport through the real daemon boundary", async () => {
		const root = fixtureRoot();
		const paths = resolveJittorPaths({
			home: root,
			uid: 1000,
			env: {
				XDG_DATA_HOME: join(root, "data"),
				XDG_STATE_HOME: join(root, "state"),
				XDG_RUNTIME_DIR: join(root, "run"),
				XDG_CONFIG_HOME: join(root, "config"),
			},
		});
		const daemon = await startDaemon(paths, { HOME: root, JITTOR_PI_SESSIONS_DIR: join(root, "sessions") });
		try {
			const client = connectJittorClient(paths);
			expect(await client.call("usage.import", { dryRun: true })).toMatchObject({ dryRun: true, discovered: 1, imported: 0 });
			expect(await client.call("usage.import", {})).toMatchObject({ imported: 1, duplicates: 0 });
			expect(await client.call("usage.import", {})).toMatchObject({ imported: 0, duplicates: 1 });
			expect(await client.call("usage.import_status", {})).toMatchObject({ running: false, lastResult: { duplicates: 1 } });
		} finally {
			await daemon.stop();
		}
	});
});
