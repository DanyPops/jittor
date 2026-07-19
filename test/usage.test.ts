import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildUsageHistogram } from "../src/domain/usage.ts";
import { renderUsageHistogram, showUsagePanel } from "../extension/src/usage.ts";
import { registerJittorExtension } from "../extension/src/index.ts";
import type { StoredMetricObservation } from "../src/domain/metric.ts";

const hour = 60 * 60 * 1_000;
const now = Date.UTC(2026, 6, 19, 12);

function metric(id: number, observedAt: number, scope: string, name: string, value: number): StoredMetricObservation {
	const [provider, ...model] = scope.split(":");
	return { id, source: "pi", scope, metric: name, value, unit: "tokens", observedAt, attributes: { provider, model: model.join(":") } };
}

const observations = [
	metric(1, now - 20 * hour, "openai-codex:gpt-5.6-sol", "input-tokens", 8_000),
	metric(2, now - 20 * hour, "openai-codex:gpt-5.6-sol", "output-tokens", 2_000),
	metric(3, now - 8 * hour, "openrouter:openai/gpt-4.1-mini", "input-tokens", 4_000),
	metric(4, now - 8 * hour, "openrouter:openai/gpt-4.1-mini", "output-tokens", 1_000),
	metric(5, now - 2 * hour, "openai-codex:gpt-5.6-sol", "cache-read-tokens", 3_000),
];

describe("usage histogram projection", () => {
	it("buckets token observations and preserves provider/model series", () => {
		const chart = buildUsageHistogram(observations, { range: "24h", now, bucketCount: 4 });
		expect(chart.totalTokens).toBe(18_000);
		expect(chart.buckets.map((bucket) => bucket.total)).toEqual([10_000, 0, 5_000, 3_000]);
		expect(chart.series.map((series) => [series.provider, series.model, series.total])).toEqual([
			["openai-codex", "gpt-5.6-sol", 13_000],
			["openrouter", "openai/gpt-4.1-mini", 5_000],
		]);
		expect(chart.breakdown).toEqual({ input: 12_000, output: 3_000, cacheRead: 3_000, cacheWrite: 0 });
	});
});

describe("usage histogram TUI", () => {
	it("exposes usage only through the single /jittor command", async () => {
		const commands = new Map<string, unknown>();
		const calls: string[] = [];
		const pi = {
			registerCommand(name: string, command: unknown) { commands.set(name, command); },
			on() {},
		} as unknown as ExtensionAPI;
		registerJittorExtension(pi, { async call(operation: string) { calls.push(operation); return observations; } });
		expect([...commands.keys()]).toEqual(["jittor"]);

		const notifications: string[] = [];
		const command = commands.get("jittor") as { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
		await command.handler("usage", {
			mode: "print",
			ui: { notify(message: string) { notifications.push(message); } },
		} as unknown as ExtensionCommandContext);
		expect(calls).toEqual(["metrics.query"]);
		expect(notifications.join("\n")).toContain("Tokens over time");
	});

	it("renders a width-bounded colored block histogram with X/Y axes and a legend", () => {
		const chart = buildUsageHistogram(observations, { range: "24h", now, bucketCount: 4 });
		const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `**${text}**` };
		const lines = renderUsageHistogram(chart, 72, theme);
		expect(lines.some((line) => line.includes("Tokens over time"))).toBe(true);
		expect(lines.some((line) => line.includes("10k") && line.includes("│"))).toBe(true);
		expect(lines.some((line) => line.includes("└") && line.includes("─"))).toBe(true);
		expect(lines.join("\n")).toContain("█");
		expect(lines.join("\n")).toContain("openai-codex/gpt-5.6-sol");
		expect(lines.every((line) => line.replace(/<[^>]+>/g, "").replace(/\*\*/g, "").length <= 72)).toBe(true);
	});

	it("queries only daemon metrics and supports range changes", async () => {
		const calls: Array<{ operation: string; input: any }> = [];
		const client = { async call(operation: string, input: any) {
			calls.push({ operation, input });
			if (operation === "metrics.query") return observations;
			throw new Error(`unexpected operation ${operation}`);
		} };
		let panels = 0;
		const ctx = {
			mode: "tui",
			ui: { async custom(factory: Function) {
				const component = factory({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => undefined);
				expect(component.render(80).join("\n")).toContain("Tokens over time");
				return panels++ === 0 ? "range-next" : "close";
			} },
		} as unknown as ExtensionCommandContext;
		await showUsagePanel(ctx, client, now);
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.operation === "metrics.query" && call.input.source === "pi")).toBe(true);
		expect(calls[0]!.input.since).toBe(now - 24 * hour);
		expect(calls[1]!.input.since).toBe(now - 7 * 24 * hour);
	});
});
