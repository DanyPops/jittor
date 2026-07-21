import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildCostGraph, buildUsageGraph, USAGE_PERIODS, type UsageGraph } from "../src/domain/usage.ts";
import { renderCostGraph, renderUsageGraph, showUsagePanel } from "../extension/src/usage.ts";
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

/** Fakes the daemon's per-scope query fan-out: metrics.distinct_scopes then one metrics.query per scope. */
function fakePiClient(rows: StoredMetricObservation[]) {
	const calls: Array<{ operation: string; input: any }> = [];
	return {
		calls,
		async call(operation: string, input: any): Promise<unknown> {
			calls.push({ operation, input });
			const inWindow = (row: StoredMetricObservation) =>
				(!input.source || row.source === input.source)
				&& (input.since === undefined || row.observedAt >= input.since)
				&& (input.until === undefined || row.observedAt <= input.until);
			if (operation === "metrics.distinct_scopes") {
				const scopes = [...new Set(rows.filter(inWindow).map((row) => row.scope))].sort();
				return scopes.slice(0, input.limit ?? scopes.length);
			}
			if (operation === "metrics.query") {
				return rows.filter((row) => inWindow(row) && (!input.scope || row.scope === input.scope));
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
}

describe("usage graph projection", () => {
	it("uses explicit periods, buckets token observations, and preserves provider/model series", () => {
		expect(USAGE_PERIODS.map(({ id, label }) => [id, label])).toEqual([
			["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["quarterly", "Quarterly"],
		]);
		const chart = buildUsageGraph(observations, { period: "daily", now, bucketCount: 4 });
		expect(chart.totalTokens).toBe(18_000);
		expect(chart.buckets.map((bucket) => bucket.total)).toEqual([10_000, 0, 5_000, 3_000]);
		expect(chart.series.map((series) => [series.provider, series.model, series.total])).toEqual([
			["openai-codex", "gpt-5.6-sol", 13_000],
			["openrouter", "openai/gpt-4.1-mini", 5_000],
		]);
		expect(chart.breakdown).toEqual({ input: 12_000, output: 3_000, cacheRead: 3_000, cacheWrite: 0 });
	});
});

describe("cost graph projection", () => {
	function costMetric(id: number, observedAt: number, scope: string, usd: number): StoredMetricObservation {
		const [provider, ...model] = scope.split(":");
		return { id, source: "pi", scope, metric: "cost", value: usd, unit: "usd", observedAt, attributes: { provider, model: model.join(":") } };
	}

	it("buckets already-recorded per-message cost by time and provider/model, ignoring token rows", () => {
		const rows = [
			costMetric(1, now - 20 * hour, "openai-codex:gpt-5.6-sol", 0.12),
			costMetric(2, now - 8 * hour, "openrouter:openai/gpt-4.1-mini", 0.03),
			metric(99, now - 8 * hour, "openrouter:openai/gpt-4.1-mini", "input-tokens", 4_000),
		];
		const chart = buildCostGraph(rows, { period: "daily", now, bucketCount: 4 });
		expect(chart.totalUsd).toBeCloseTo(0.15);
		expect(chart.series.map((series) => [series.provider, series.model, series.total])).toEqual([
			["openai-codex", "gpt-5.6-sol", 0.12],
			["openrouter", "openai/gpt-4.1-mini", 0.03],
		]);
	});

	it("ignores negative or non-numeric cost values without throwing", () => {
		const rows = [
			costMetric(1, now - 4 * hour, "openai-codex:gpt-5.6-sol", -1),
			{ id: 2, source: "pi", scope: "openai-codex:gpt-5.6-sol", metric: "cost", value: null, unit: "usd" as const, observedAt: now - 2 * hour, attributes: {} },
		];
		expect(() => buildCostGraph(rows, { period: "daily", now, bucketCount: 4 })).not.toThrow();
		expect(buildCostGraph(rows, { period: "daily", now, bucketCount: 4 }).totalUsd).toBe(0);
	});
});

describe("usage graph TUI", () => {
	it("exposes usage through its own dedicated /usage command, separate from /jittor", async () => {
		// Command dispatch calls showUsagePanel with the real Date.now(), not the fixed test `now`
		// constant, so this fixture must actually be recent (unlike the other tests below, which pass
		// an explicit `now` to showUsagePanel directly and can use the fixed constant).
		const recentObservations = [metric(1, Date.now() - 60_000, "openai-codex:gpt-5.6-sol", "input-tokens", 8_000)];
		const commands = new Map<string, unknown>();
		const fake = fakePiClient(recentObservations);
		const pi = {
			registerCommand(name: string, command: unknown) { commands.set(name, command); },
			on() {},
		} as unknown as ExtensionAPI;
		registerJittorExtension(pi, fake);
		expect([...commands.keys()]).toEqual(["jittor", "usage"]);

		const notifications: string[] = [];
		const command = commands.get("usage") as { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
		await command.handler("", {
			mode: "print",
			ui: { notify(message: string) { notifications.push(message); } },
		} as unknown as ExtensionCommandContext);
		expect(fake.calls.map((call) => call.operation)).toEqual(["metrics.distinct_scopes", "metrics.query"]);
		expect(notifications.join("\n")).toContain("Hourly token usage");
		notifications.length = 0;
		await command.handler("cost", {
			mode: "print",
			ui: { notify(message: string) { notifications.push(message); } },
		} as unknown as ExtensionCommandContext);
		expect(notifications.join("\n")).toContain("Hourly cost");
	});

	it("opens directly into the cost view when requested, independent of command dispatch", async () => {
		const fake = fakePiClient(observations);
		const notifications: string[] = [];
		const ctx = { mode: "print", ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
		const budgets = { getUsageTokenBudget: () => undefined };
		await showUsagePanel(ctx, fake, budgets, now, "cost");
		expect(notifications.join("\n")).toContain("Hourly cost");
	});

	it("fetches per distinct scope instead of one flat query, so a heavy scope cannot starve another out of the window", async () => {
		// Simulate the real-world bug: many recent rows for one scope, and a single row for another,
		// both well inside the same (default Hourly) window.
		const heavyScope = Array.from({ length: 50 }, (_, index) => metric(1_000 + index, now - 50 * 60_000 + index * 10, "anthropic-vertex:claude-sonnet-5", "input-tokens", 10));
		const starvedScope = [metric(2, now - 55 * 60_000, "openai-codex:gpt-5.6-sol", "input-tokens", 8_000)];
		const fake = fakePiClient([...heavyScope, ...starvedScope]);
		const notifications: string[] = [];
		const ctx = { mode: "print", ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
		const budgets = { getUsageTokenBudget: () => undefined };
		await showUsagePanel(ctx, fake, budgets, now, "tokens");
		// distinct_scopes finds both scopes up front, so the starved (much lower-volume) scope is never
		// at risk of being crowded out by row-count alone, unlike the old single flat "most recent N rows" query.
		const distinctScopeCalls = fake.calls.filter((call) => call.operation === "metrics.distinct_scopes");
		expect(distinctScopeCalls).toHaveLength(1);
		const perScopeQueries = fake.calls.filter((call) => call.operation === "metrics.query").map((call) => call.input.scope);
		expect(new Set(perScopeQueries)).toEqual(new Set(["anthropic-vertex:claude-sonnet-5", "openai-codex:gpt-5.6-sol"]));
	});

	it("renders a bounded cumulative graph with an honest configured threshold and over-budget state", () => {
		const chart = buildUsageGraph(observations, { period: "daily", now, bucketCount: 4 });
		const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `**${text}**` };
		const lines = renderUsageGraph(chart, 72, theme, 15_000);
		expect(lines.some((line) => line.includes("Daily token usage"))).toBe(true);
		expect(lines.some((line) => line.includes("OVER BUDGET") && line.includes("3k"))).toBe(true);
		expect(lines.some((line) => line.includes("15k") && line.includes("┄"))).toBe(true);
		expect(lines.some((line) => line.includes("9k") && line.includes("│"))).toBe(true);
		expect(lines.some((line) => line.includes("└") && line.includes("─"))).toBe(true);
		expect(lines.join("\n")).toContain("█");
		expect(lines.join("\n")).toContain("openai-codex/gpt-5.6-sol");
		expect(lines.every((line) => line.replace(/<[^>]+>/g, "").replace(/\*\*/g, "").length <= 72)).toBe(true);
	});

	it("colors distinct provider/model series with a non-status categorical palette, stacking multiple colors into one bucket once they share cumulative time", () => {
		const twoModelObservations = [
			metric(1, now - 10 * hour, "openai-codex:gpt-5.6-sol", "input-tokens", 4_000),
			metric(2, now - 4 * hour, "openrouter:openai/gpt-4.1-mini", "input-tokens", 2_000),
		];
		const chart = buildUsageGraph(twoModelObservations, { period: "daily", now, bucketCount: 4 });
		expect(chart.series).toHaveLength(2);
		const colorCalls: string[] = [];
		const theme = { fg: (color: string, text: string) => { colorCalls.push(color); return text; }, bold: (text: string) => text };
		renderUsageGraph(chart, 72, theme, undefined);
		const seriesColorsUsed = new Set(colorCalls.filter((color) => color !== "borderMuted" && color !== "muted"));
		expect(seriesColorsUsed.size).toBeGreaterThan(1);
		for (const statusColor of ["success", "warning", "error"]) expect(seriesColorsUsed.has(statusColor)).toBe(false);
	});

	it("renders a single-model chart with exactly one series color, since there is nothing to distinguish", () => {
		const oneModel = [metric(1, now - 4 * hour, "openai-codex:gpt-5.6-sol", "input-tokens", 4_000)];
		const chart = buildUsageGraph(oneModel, { period: "daily", now, bucketCount: 4 });
		const colorCalls: string[] = [];
		const theme = { fg: (color: string, text: string) => { colorCalls.push(color); return text; }, bold: (text: string) => text };
		renderUsageGraph(chart, 72, theme, undefined);
		const seriesColorsUsed = new Set(colorCalls.filter((color) => color !== "borderMuted" && color !== "muted"));
		expect(seriesColorsUsed.size).toBe(1);
	});

	it("adds bold as a second visual channel once the hue palette is exhausted, instead of repeating an indistinguishable color", () => {
		const seriesCount = 10;
		const series = Array.from({ length: seriesCount }, (_, index) => ({ key: `p${index}/m${index}`, provider: `p${index}`, model: `m${index}`, total: seriesCount - index }));
		const bucketSeries: Record<string, number> = {};
		for (const item of series) bucketSeries[item.key] = item.total;
		const chart: UsageGraph = {
			period: "daily", start: now - 24 * hour, end: now,
			buckets: [{ start: now - 24 * hour, end: now, total: series.reduce((sum, item) => sum + item.total, 0), series: bucketSeries }],
			series, totalTokens: series.reduce((sum, item) => sum + item.total, 0),
			breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, truncated: false,
		};
		const boldCalls: string[] = [];
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => { boldCalls.push(text); return text; } };
		renderUsageGraph(chart, 100, theme);
		expect(boldCalls.length).toBeGreaterThan(0);
	});

	it("renders under-budget and unconfigured states without inventing provider-derived allowances", () => {
		const chart = buildUsageGraph(observations, { period: "daily", now, bucketCount: 4 });
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		expect(renderUsageGraph(chart, 72, theme, 20_000).join("\n")).toContain("2k remaining");
		const unconfigured = renderUsageGraph(chart, 72, theme).join("\n");
		expect(unconfigured).toContain("budget not configured");
		expect(unconfigured).not.toContain("OVER BUDGET");
		const truncated = buildUsageGraph(observations, { period: "daily", now, bucketCount: 4, truncated: true });
		const bounded = renderUsageGraph(truncated, 72, theme, 20_000).join("\n");
		expect(bounded).toContain("state unknown");
		expect(bounded).toContain("query limit reached");
		expect(bounded).not.toContain("remaining");
	});

	it("persists token thresholds only from explicit usage-budget commands", async () => {
		const commands = new Map<string, any>();
		const budgets: Record<string, number | undefined> = {};
		const control = {
			isEnabled: () => true, setEnabled() {}, isFooterEnabled: () => true, setFooterEnabled() {},
			getUsageTokenBudget(period: string) { return budgets[period]; },
			setUsageTokenBudget(period: string, tokens: number | undefined) { budgets[period] = tokens; },
		};
		registerJittorExtension({ registerCommand(name: string, command: unknown) { commands.set(name, command); }, on() {} } as unknown as ExtensionAPI, { async call() { return []; } }, control);
		const notifications: string[] = [];
		const ctx = { mode: "print", ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
		await commands.get("usage").handler("budget daily 250,000", ctx);
		expect(budgets.daily).toBe(250_000);
		await commands.get("usage").handler("budget", ctx);
		expect(notifications.at(-1)).toContain("Daily: 250,000");
		await commands.get("usage").handler("budget daily off", ctx);
		expect(budgets.daily).toBeUndefined();
	});

	it("cycles time frame with Tab and Shift+Tab, in addition to the arrow keys", async () => {
		const client = fakePiClient(observations);
		const renders: string[] = [];
		let panel = 0;
		const ctx = {
			mode: "tui",
			ui: { async custom(factory: Function) {
				let doneValue: string | undefined;
				const component = factory({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, (value: string) => { doneValue = value; });
				renders.push(component.render(80).join("\n"));
				if (panel === 0) component.handleInput("\t"); // Tab -> next time frame
				else if (panel === 1) component.handleInput("\x1b[Z"); // Shift+Tab -> previous time frame
				else component.handleInput("\x1b"); // Escape -> close
				panel += 1;
				return doneValue;
			} },
		} as unknown as ExtensionCommandContext;
		const budgets = { getUsageTokenBudget: () => undefined };
		await showUsagePanel(ctx, client, budgets, now);
		expect(panel).toBe(3);
		expect(renders[0]).toContain("Hourly token usage");
		expect(renders[1]).toContain("Daily token usage");
		expect(renders[2]).toContain("Hourly token usage");
	});

	it("queries only daemon metrics and supports period changes", async () => {
		const client = fakePiClient(observations);
		let panels = 0;
		const ctx = {
			mode: "tui",
			ui: { async custom(factory: Function) {
				const component = factory({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => undefined);
				expect(component.render(80).join("\n")).toContain(panels === 0 ? "Hourly token usage" : "Daily token usage");
				return panels++ === 0 ? "period-next" : "close";
			} },
		} as unknown as ExtensionCommandContext;
		const budgets = { getUsageTokenBudget(period: string) { return period === "daily" ? 20_000 : undefined; } };
		await showUsagePanel(ctx, client, budgets, now);
		// Hourly finds no scopes at all (every fixture row is older than 1 hour): just 1 distinct_scopes
		// call. Daily finds both fixture scopes: 1 distinct_scopes call + 1 metrics.query per scope.
		expect(client.calls).toHaveLength(4);
		expect(client.calls.every((call) => call.input.source === "pi")).toBe(true);
		const distinctScopeCalls = client.calls.filter((call) => call.operation === "metrics.distinct_scopes");
		expect(distinctScopeCalls.map((call) => call.input.since)).toEqual([now - hour, now - 24 * hour]);
		const queryCalls = client.calls.filter((call) => call.operation === "metrics.query");
		expect(queryCalls).toHaveLength(2);
		expect(queryCalls.every((call) => call.input.since === now - 24 * hour)).toBe(true);
		expect(client.calls.some((call) => call.input.source === "codex-subscription")).toBe(false);
	});
});
