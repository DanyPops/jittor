import { describe, expect, it } from "bun:test";
import { formatMetricsQuery, formatRouterStatus, runCli } from "../src/cli.ts";
import type { ContextAssessment } from "../src/domain/context-telemetry.ts";
import type { RouterStatus } from "../src/ports/router-controller.ts";
import type { StoredMetricObservation } from "../src/domain/metric.ts";

const summary: ContextAssessment = {
	window: { since: 1_000, until: 2_000 }, completeness: "complete",
	injection: { runs: 2, averageCharacters: 200, p95Characters: 300, maxCharacters: 300, estimatedTokens: 100, unchangedRate: 0.5, averageShare: 0.2, ruleCharacters: 160, taskCharacters: 240 },
	compaction: { completed: 1, aborted: 0, averageDurationMs: 500, perRun: 0.5, perTurn: 0.25, perHour: 3_600, averageTurnsBetween: 4, averageElapsedMsBetween: 1_000, averageProviderTokensBetween: 2_000, averageCacheReadTokensBetween: 1_000, reasons: { manual: 0, threshold: 1, overflow: 0 } },
};

describe("Jittor CLI context telemetry parity", () => {
	it("publishes the jittor executable", async () => {
		const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as { bin?: Record<string, string> };
		expect(manifest.bin?.jittor).toBe("src/cli.ts");
	});
	it("exposes stable bounded JSON through the authenticated typed client", async () => {
		const output: string[] = [];
		const calls: Array<{ operation: string; input: unknown }> = [];
		const code = await runCli(["context", "--json", "--since", "1000", "--until", "2000"], {
			client: { async call(operation: "context.assess", input: { since?: number; until?: number }) { calls.push({ operation, input }); return summary; } } as never,
			stdout: (line: string) => output.push(line), stderr: () => {}, systemctl: () => {}, installService: () => {}, serve: () => {},
		});
		expect(code).toBe(0);
		expect(calls).toEqual([{ operation: "context.assess", input: { since: 1_000, until: 2_000 } }]);
		expect(JSON.parse(output.join("\n"))).toEqual(summary);
	});

	it("exposes benchmark refresh and query through independent JSON and human presenters", async () => {
		const output: string[] = [];
		const calls: Array<{ operation: string; input: unknown }> = [];
		const result = {
			sourceId: "openrouter-models", snapshotId: "snapshot-1", retrievedAt: 1_000, publishedAt: 1_000, completeness: "complete" as const, freshness: "fresh" as const, freshUntil: 100_000,
			observations: [{
				model: { provider: "openai", model: "gpt-5.4", version: null, canonical: "openai/gpt-5.4", aliases: [] }, dimension: "price-input", value: 0.000002, unit: "usd",
				provenance: { sourceId: "openrouter-models", sourceType: "marketplace", publisher: "OpenRouter", url: "https://openrouter.ai/api/v1/models", revision: "r1", publishedAt: null, retrievedAt: 1_000, freshUntil: 100_000, license: "OpenRouter API terms", confidence: 0.9 }, methodology: { basis: "price per input token" },
			}],
		};
		const client = { async call(operation: string, input: unknown) { calls.push({ operation, input }); return result; } };
		expect(await runCli(["benchmarks", "list", "--source", "openrouter-models", "--json"], {
			client: client as never, stdout: (line) => output.push(line), stderr: (line) => output.push(line), systemctl: () => {}, installService: () => {}, serve: () => {},
		})).toBe(0);
		expect(calls).toEqual([{ operation: "benchmark.query", input: { sourceId: "openrouter-models" } }]);
		expect(JSON.parse(output[0]!)).toEqual(result);
		output.length = 0;
		expect(await runCli(["benchmarks", "list", "--source", "openrouter-models"], {
			client: client as never, stdout: (line) => output.push(line), stderr: (line) => output.push(line), systemctl: () => {}, installService: () => {}, serve: () => {},
		})).toBe(0);
		expect(output.join("\n")).toContain("openai/gpt-5.4");
		expect(output.join("\n")).toContain("OpenRouter");
	});

	it("exposes model ranking with explicit candidates and scope authority", async () => {
		const output: string[] = [];
		const calls: Array<{ operation: string; input: any }> = [];
		const ranking = { scopeAuthority: "available-models", scopeWarning: "Pi available models are not the exact session scope", taskClass: "coding", completeness: "insufficient-evidence", ranked: [], automaticSelection: null };
		const client = { async call(operation: string, input: unknown) { calls.push({ operation, input }); return ranking; } };
		expect(await runCli(["benchmarks", "rank", "--candidate", "openai/gpt-5.4@high", "--source", "openrouter-models", "--task", "coding", "--budget", "0.5", "--json"], {
			client: client as never, stdout: (line) => output.push(line), stderr: () => {}, systemctl: () => {}, installService: () => {}, serve: () => {},
		})).toBe(0);
		expect(calls[0]).toMatchObject({ operation: "models.rank", input: { candidates: [{ provider: "openai", model: "gpt-5.4", thinking: "high" }], scopeAuthority: "available-models", taskClass: "coding", budgetPressure: 0.5, sourceIds: ["openrouter-models"] } });
		expect(JSON.parse(output[0]!)).toEqual(ranking);
	});

	it("records, queries, and prunes metrics through the typed daemon client with validated flags", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const client = { async call(operation: string, input: unknown) { calls.push({ operation, input }); return { deleted: 3 }; } };
		const deps = { client: client as never, stdout: () => {}, stderr: () => {}, systemctl: () => {}, installService: () => {}, serve: () => {} };
		expect(await runCli(["metrics", "record", "--source", "anthropic", "--scope", "tokens", "--metric", "used-fraction", "--value", "0.25", "--unit", "ratio", "--observed-at", "1000", "--attributes", '{"limit":100}', "--json"], deps)).toBe(0);
		expect(calls[0]).toEqual({ operation: "metrics.record", input: { source: "anthropic", scope: "tokens", metric: "used-fraction", value: 0.25, unit: "ratio", observedAt: 1_000, attributes: { limit: 100 } } });
		expect(await runCli(["metrics", "record", "--source", "s", "--scope", "sc", "--metric", "m", "--value", "null", "--unit", "count", "--json"], deps)).toBe(0);
		expect((calls[1]!.input as { value: unknown }).value).toBeNull();
		expect(await runCli(["metrics", "record", "--source", "s", "--scope", "sc", "--metric", "m", "--value", "1", "--unit", "not-a-real-unit"], deps)).toBe(2);
		expect(await runCli(["metrics", "query", "--since", "10", "--until", "5"], deps)).toBe(2);
		expect(await runCli(["metrics", "prune", "--before", "1000", "--json"], deps)).toBe(0);
		expect(calls.at(-1)).toEqual({ operation: "metrics.prune", input: { before: 1_000 } });
		expect(await runCli(["metrics", "prune", "--before", "1000", "--force", "--json"], deps)).toBe(0);
		expect(calls.at(-1)).toEqual({ operation: "metrics.prune", input: { before: 1_000, force: true } });
	});

	it("applies and clears a router override with an explicit route and optional expiry", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const client = { async call(operation: string, input: unknown) { calls.push({ operation, input }); return {}; } };
		const deps = { client: client as never, stdout: () => {}, stderr: () => {}, systemctl: () => {}, installService: () => {}, serve: () => {} };
		expect(await runCli(["router", "override", "--route", "openai/gpt-5.4@high", "--expires-at", "5000", "--json"], deps)).toBe(0);
		expect(calls[0]).toEqual({ operation: "router.override", input: { route: { provider: "openai", model: "gpt-5.4", thinking: "high" }, expiresAt: 5_000 } });
		expect(await runCli(["router", "clear-override", "--json"], deps)).toBe(0);
		expect(calls[1]).toEqual({ operation: "router.clear_override", input: {} });
		expect(await runCli(["router", "override", "--route", "not-a-route"], deps)).toBe(2);
		expect(await runCli(["router", "available-routes", "--route", "openai/gpt-5.4@high", "--route", "openrouter/x/y@medium", "--json"], deps)).toBe(0);
		expect(calls.at(-1)).toEqual({
			operation: "router.available_routes",
			input: { routes: [{ provider: "openai", model: "gpt-5.4", thinking: "high" }, { provider: "openrouter", model: "x/y", thinking: "medium" }] },
		});
	});

	it("never prints the daemon bearer token or a provider credential in status, error, or human output", async () => {
		const secretToken = "super-secret-daemon-token-should-never-appear";
		const output: string[] = [];
		const status: RouterStatus = {
			ready: true, paused: false,
			sources: [{ id: "codex-subscription", provider: "openai-codex", ok: true, metrics: 3 }],
			lastDecision: { action: "continue", pressure: 0.2, reason: "within budget", decidedAt: 1_000, trace: [] },
			override: null, currentRoute: { provider: "anthropic", model: "claude-sonnet-5", thinking: "high" }, availableRoutes: [],
		};
		const client = {
			async call() { return status; },
		};
		expect(await runCli(["router", "status"], {
			client: client as never, stdout: (line) => output.push(line), stderr: (line) => output.push(line), systemctl: () => {}, installService: () => {}, serve: () => {},
		})).toBe(0);
		expect(output.join("\n")).not.toContain(secretToken);
		expect(formatRouterStatus(status)).not.toContain(secretToken);

		const failing = { async call() { throw new Error("Jittor daemon is not running; install or start jittor.service"); } };
		const errors: string[] = [];
		expect(await runCli(["router", "status"], {
			client: failing as never, stdout: () => {}, stderr: (line) => errors.push(line), systemctl: () => {}, installService: () => {}, serve: () => {},
		})).toBe(1);
		expect(errors.join("\n")).not.toContain(secretToken);
		expect(errors.join("\n")).toContain("install or start jittor.service");
	});

	it("bounds human-readable metric rows and reports how many were omitted", () => {
		const rows: StoredMetricObservation[] = Array.from({ length: 75 }, (_, index) => ({
			id: index, source: "openrouter", scope: "key:default", metric: "usage", value: index, unit: "usd", observedAt: 1_000 + index, attributes: {},
		}));
		const text = formatMetricsQuery(rows);
		expect(text).toContain("75 observation(s)");
		expect(text).toContain("showing first 50");
		expect(text.split("\n")).toHaveLength(51);
	});

	it("renders actionable human output and rejects invalid bounds", async () => {
		const output: string[] = [];
		const deps = {
			client: { async call(_operation: "context.assess", _input: { since?: number; until?: number }) { return summary; } } as never, stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line),
			systemctl: () => {}, installService: () => {}, serve: () => {},
		};
		expect(await runCli(["context"], deps)).toBe(0);
		expect(output.join("\n")).toContain("Papyrus injection");
		expect(output.join("\n")).toContain("Compactions");
		expect(await runCli(["context", "--since", "later"], deps)).toBe(2);
	});
});
