import { describe, expect, it } from "bun:test";
import { runCli } from "../src/cli.ts";
import type { ContextAssessment } from "../src/domain/context-telemetry.ts";

const summary: ContextAssessment = {
	window: { since: 1_000, until: 2_000 }, completeness: "complete",
	injection: { runs: 2, averageCharacters: 200, p95Characters: 300, maxCharacters: 300, estimatedTokens: 100, unchangedRate: 0.5, averageShare: 0.2, ruleCharacters: 160, taskCharacters: 240 },
	compaction: { completed: 1, aborted: 0, averageDurationMs: 500, perRun: 0.5, perTurn: 0.25, perHour: 3_600, averageTurnsBetween: 4, averageElapsedMsBetween: 1_000, averageProviderTokensBetween: 2_000, averageCacheReadTokensBetween: 1_000, reasons: { manual: 0, threshold: 1, overflow: 0 } },
};

describe("Jittor CLI context telemetry parity", () => {
	it("exposes stable bounded JSON through the authenticated typed client", async () => {
		const output: string[] = [];
		const calls: Array<{ operation: string; input: unknown }> = [];
		const code = await runCli(["context", "--json", "--since", "1000", "--until", "2000"], {
			client: { async call(operation: "context.assess", input: { since?: number; until?: number }) { calls.push({ operation, input }); return summary; } },
			stdout: (line: string) => output.push(line), stderr: () => {}, systemctl: () => {}, installService: () => {}, serve: () => {},
		});
		expect(code).toBe(0);
		expect(calls).toEqual([{ operation: "context.assess", input: { since: 1_000, until: 2_000 } }]);
		expect(JSON.parse(output.join("\n"))).toEqual(summary);
	});

	it("renders actionable human output and rejects invalid bounds", async () => {
		const output: string[] = [];
		const deps = {
			client: { async call(_operation: "context.assess", _input: { since?: number; until?: number }) { return summary; } }, stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line),
			systemctl: () => {}, installService: () => {}, serve: () => {},
		};
		expect(await runCli(["context"], deps)).toBe(0);
		expect(output.join("\n")).toContain("Papyrus injection");
		expect(output.join("\n")).toContain("Compactions");
		expect(await runCli(["context", "--since", "later"], deps)).toBe(2);
	});
});
