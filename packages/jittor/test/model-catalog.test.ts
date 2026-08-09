import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.ts";
import {
	ModelCatalog,
	type ModelCatalogSource,
	ModelsDevCatalogSource,
	translateModelsDevCatalog,
} from "../src/optimization/model-selection/catalog.ts";
import { MetricModelCatalogStore } from "../src/optimization/model-selection/catalog-store.ts";
import { openJittorDb } from "../src/sqlite/database.ts";
import { SQLiteMetricStore } from "../src/sqlite/metric-store.ts";
import { resolveJittorPaths } from "../src/state.ts";
import { connectJittorClient } from "../src/vehicle/client.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	return {
		anthropic: {
			id: "anthropic",
			name: "Anthropic",
			doc: "https://docs.anthropic.com/models",
			env: ["ANTHROPIC_API_KEY"],
			npm: "@ai-sdk/anthropic",
			models: {
				"claude-sonnet": {
					id: "claude-sonnet-4",
					name: "Claude Sonnet",
					description: "fixture",
					attachment: true,
					reasoning: true,
					reasoning_options: [{ type: "effort", values: ["low", "high"] }],
					tool_call: true,
					structured_output: true,
					release_date: "2025-01-01",
					last_updated: "2025-02-01",
					modalities: { input: ["text", "image"], output: ["text"] },
					open_weights: false,
					limit: { context: 200_000, input: 180_000, output: 20_000 },
					cost: {
						input: 3,
						output: 15,
						reasoning: 15,
						cache_read: 0.3,
						cache_write: 3.75,
						context_over_200k: { input: 6, output: 22.5 },
						tiers: [{ tier: { type: "context", size: 1_000_000 }, input: 8, output: 30 }],
					},
					status: "deprecated",
				},
			},
		},
	};
}

describe("models.dev catalog translation", () => {
	it("preserves serving variants, capabilities, long-context tiers, and provenance", async () => {
		const snapshot = await translateModelsDevCatalog(fixture(), {
			sourceUrl: "https://models.dev/api.json",
			retrievedAt: 1_000,
			freshUntil: 2_000,
			revision: "sha256:fixture",
		});
		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0]).toMatchObject({
			provider: "anthropic",
			model: "claude-sonnet",
			aliases: ["claude-sonnet-4"],
			status: "deprecated",
			limits: { context: 200_000, input: 180_000, output: 20_000 },
			capabilities: { attachment: true, reasoning: true, toolCall: true, structuredOutput: true },
			pricing: { input: 3, output: 15, reasoning: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		expect(snapshot.entries[0]!.pricing?.tiers).toEqual([{ contextSize: 1_000_000, input: 8, output: 30 }]);
		expect(snapshot.provenance).toMatchObject({ sourceId: "models.dev", revision: "sha256:fixture", license: "MIT" });
	});

	it("rejects schema drift rather than publishing a partial snapshot", async () => {
		const malformed = fixture() as unknown as {
			anthropic: { models: Record<string, { limit: { context: unknown } }> };
		};
		malformed.anthropic.models["claude-sonnet"]!.limit.context = "many";
		expect(() =>
			translateModelsDevCatalog(malformed, {
				sourceUrl: "https://models.dev/api.json",
				retrievedAt: 1_000,
				freshUntil: 2_000,
				revision: "sha256:bad",
			}),
		).toThrow("limit.context");
	});
});

describe("model catalog lifecycle", () => {
	it("retains the last complete SQLite snapshot after a failed refresh and restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-catalog-"));
		roots.push(root);
		const path = join(root, "jittor.db");
		let fail = false;
		const source: ModelCatalogSource = {
			id: "models.dev",
			async fetch() {
				if (fail) throw new Error("offline");
				return translateModelsDevCatalog(fixture(), {
					sourceUrl: "https://models.dev/api.json",
					retrievedAt: 1_000,
					freshUntil: 2_000,
					revision: "sha256:fixture",
				});
			},
		};
		let metrics = new SQLiteMetricStore(openJittorDb(path));
		let catalog = new ModelCatalog(new MetricModelCatalogStore(metrics), source, { clock: () => 1_000 });
		expect((await catalog.refresh(true)).ok).toBe(true);
		fail = true;
		expect((await catalog.refresh(true)).ok).toBe(false);
		expect(catalog.query({ provider: "anthropic", model: "claude-sonnet" }).entries).toHaveLength(1);
		metrics.close();

		metrics = new SQLiteMetricStore(openJittorDb(path));
		catalog = new ModelCatalog(new MetricModelCatalogStore(metrics), undefined, { clock: () => 3_000 });
		const result = catalog.query({ provider: "anthropic", model: "claude-sonnet", overrides: { contextTokens: 250_000 } });
		expect(result.freshness).toBe("stale");
		expect(result.entries[0]!.limits.context).toBe(250_000);
		expect(result.entries[0]!.fieldAuthority["limits.context"]).toMatchObject({ authority: "user-override" });
		metrics.close();
	});

	it("bounds HTTP responses before parsing", async () => {
		const source = new ModelsDevCatalogSource({
			maxResponseBytes: 16,
			transport: async () => new Response(JSON.stringify(fixture())),
		});
		await expect(source.fetch()).rejects.toThrow("response exceeds");
	});

	it("aborts a timed-out HTTP transport without publishing", async () => {
		const source = new ModelsDevCatalogSource({
			timeoutMs: 5,
			transport: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		await expect(source.fetch()).rejects.toThrow("aborted");
	});

	it("refreshes and queries through a real loopback HTTP source, daemon, SQLite, and typed client", async () => {
		const server = Bun.serve({ port: 0, fetch: () => Response.json(fixture()) });
		const root = mkdtempSync(join(tmpdir(), "jittor-catalog-daemon-"));
		roots.push(root);
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
		const daemon = await startDaemon(paths, {
			JITTOR_MODELS_DEV_CATALOG: "1",
			JITTOR_MODELS_DEV_CATALOG_URL: new URL("/api.json", server.url).toString(),
		});
		try {
			const client = connectJittorClient(paths);
			expect(await client.call("catalog.refresh", { force: true })).toMatchObject({ ok: true, hasSnapshot: true, entries: 1 });
			const result = await client.call("catalog.query", { provider: "anthropic", model: "claude-sonnet-4" });
			expect(result.entries.map((entry) => entry.canonical)).toEqual(["anthropic/claude-sonnet"]);
			expect(JSON.stringify(result)).not.toContain("ANTHROPIC_API_KEY");
		} finally {
			await daemon.stop();
			server.stop(true);
		}
	});
});
