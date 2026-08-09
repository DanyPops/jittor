import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	HUMAN_STATUS_MAX_SOURCES,
	type RouterStatus,
	type StoredMetricObservation,
	USAGE_RENDER_MAX_SERIES,
	type UsageGraph,
} from "@danypops/jittor";
import { buildStatusView } from "../extension/src/observability/status.ts";
import { renderUsageGraph } from "../extension/src/observability/usage.ts";

function status(sourceCount: number): RouterStatus {
	return {
		ready: true,
		paused: false,
		sources: Array.from({ length: sourceCount }, (_, index) => ({
			id: `source-${index}`,
			provider: "provider",
			ok: index % 2 === 0,
			metrics: index,
			observedAt: 1_000,
			error: "oauth-super-secret must never be presented",
		})),
		lastDecision: null,
		override: null,
		currentRoute: { provider: "provider", model: "model", thinking: "medium" },
		availableRoutes: [],
	};
}

describe("Jittor extension output-channel conformance", () => {
	it("classifies native model-tool output as explicitly non-applicable", () => {
		const extension = readFileSync(join(import.meta.dir, "../extension/src/index.ts"), "utf8");
		const panel = readFileSync(join(import.meta.dir, "../extension/src/observability/status.ts"), "utf8");
		const documentation = readFileSync(join(import.meta.dir, "../../jittor/docs/OUTPUT_CHANNELS.md"), "utf8");
		expect(extension).not.toContain("registerTool(");
		expect(extension).toContain("registerCommand(");
		expect(panel).not.toMatch(/JSON\.(?:parse|stringify)/);
		expect(documentation).toContain("explicitly **not applicable**");
		expect(documentation).toContain("Adding any `registerTool(...)` call requires");
	});

	it("bounds and sanitizes human status panels", () => {
		const lines = buildStatusView(status(HUMAN_STATUS_MAX_SOURCES + 20), [], 2_000);
		expect(lines.filter((line) => line.startsWith("  source-")).length).toBe(HUMAN_STATUS_MAX_SOURCES);
		expect(lines.join("\n")).not.toContain("oauth-super-secret");
		expect(lines.join("\n")).toContain("more telemetry sources omitted");
	});

	it("reports a missing active-daemon Codex source without exposing credential details or an old percentage", () => {
		const codexStatus: RouterStatus = {
			...status(0),
			currentRoute: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
		};
		const metrics: StoredMetricObservation[] = [
			{
				id: 1,
				source: "codex-subscription",
				scope: "codex:secondary",
				metric: "used-fraction",
				value: 0.98,
				unit: "ratio",
				observedAt: 1,
				attributes: {
					limitId: "codex",
					windowSeconds: 604_800,
					resetsAt: 1_500,
					authFile: "/home/private/.codex/auth.json",
					token: "oauth-super-secret",
				},
			},
		];
		const lines = buildStatusView(codexStatus, metrics, 2_000_000);
		const text = lines.join("\n");
		expect(text).toContain("Codex weekly: reset pending");
		expect(text).toContain("codex-subscription: unavailable · not configured by active daemon");
		expect(text).not.toContain("2.0% left");
		expect(text).not.toContain("auth.json");
		expect(text).not.toContain("oauth-super-secret");
	});

	it("bounds usage legend output regardless of model cardinality", () => {
		const series = Array.from({ length: USAGE_RENDER_MAX_SERIES + 20 }, (_, index) => ({
			key: `provider-${index}/model-${index}`,
			provider: `provider-${index}`,
			model: `model-${index}`,
			total: 1,
		}));
		const graph: UsageGraph = {
			period: "hourly",
			start: 0,
			end: 3_600_000,
			totalTokens: series.length,
			breakdown: { input: series.length, output: 0, cacheRead: 0, cacheWrite: 0 },
			buckets: [{ start: 0, end: 3_600_000, total: series.length, series: Object.fromEntries(series.map((item) => [item.key, 1])) }],
			series,
			truncated: false,
		};
		const lines = renderUsageGraph(graph, 80, { fg: (_color, text) => text, bold: (text) => text });
		expect(lines.filter((line) => line.startsWith("■ ")).length).toBe(USAGE_RENDER_MAX_SERIES);
		expect(lines.join("\n")).toContain("more series omitted");
		expect(lines.every((line) => line.length <= 80)).toBe(true);
	});
});
