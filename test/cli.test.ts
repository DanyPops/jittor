import { describe, expect, it } from "bun:test";
import { runCli } from "../src/cli.ts";
import type { ContextAssessment } from "../src/domain/context-telemetry.ts";

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
