import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildCostGraph,
	buildUsageGraph,
	resolveUsageWindow,
	usageBucketIndex,
	USAGE_PERIODS,
	type UsageAggregateRow,
	type UsageBucketWindow,
	type UsageGraph,
} from "../src/domain/usage.ts";
import { renderCostGraph, renderUsageGraph, showUsagePanel } from "../extension/src/usage.ts";
import { registerJittorExtension } from "../extension/src/index.ts";

const hour = 60 * 60 * 1_000;
const now = Date.UTC(2026, 6, 19, 12);

interface RawEvent { observedAt: number; scope: string; metric: string; value: number }

/** What the daemon's SQL-side GROUP BY does: sums raw events into (scope, metric, bucketIndex) cells for a given window. Used both to build domain-level fixtures and inside fakePiClient below, so both stay provably consistent with the real aggregation contract. */
function aggregate(events: RawEvent[], window: UsageBucketWindow): UsageAggregateRow[] {
	const sums = new Map<string, UsageAggregateRow>();
	for (const event of events) {
		const bucketIndex = usageBucketIndex(event.observedAt, window);
		const key = `${event.scope}\u0000${event.metric}\u0000${bucketIndex}`;
		const existing = sums.get(key);
		if (existing) existing.sum += event.value;
		else sums.set(key, { scope: event.scope, metric: event.metric, bucketIndex, sum: event.value });
	}
	return [...sums.values()];
}

const events: RawEvent[] = [
	{ observedAt: now - 20 * hour, scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 8_000 },
	{ observedAt: now - 20 * hour, scope: "openai-codex:gpt-5.6-sol", metric: "output-tokens", value: 2_000 },
	{ observedAt: now - 8 * hour, scope: "openrouter:openai/gpt-4.1-mini", metric: "input-tokens", value: 4_000 },
	{ observedAt: now - 8 * hour, scope: "openrouter:openai/gpt-4.1-mini", metric: "output-tokens", value: 1_000 },
	{ observedAt: now - 2 * hour, scope: "openai-codex:gpt-5.6-sol", metric: "cache-read-tokens", value: 3_000 },
];

/**
 * Simulates the daemon's single "metrics.usage_series" operation: discover distinct scopes
 * (bounded, so a real scope-count explosion still truncates honestly), then SQL-side aggregate
 * events into (scope, metric, bucketIndex) sums for the caller-specified window -- never a raw,
 * per-scope-row-capped fetch. Reuses the same `aggregate` helper the assertions build fixtures
 * with, and the real `usageBucketIndex`/window math from src/domain/usage.ts, so this fake is
 * provably faithful to the real aggregation contract rather than a hand-waved approximation.
 */
function fakePiClient(source: RawEvent[]) {
	const calls: Array<{ operation: string; input: any }> = [];
	return {
		calls,
		async call(operation: string, input: any): Promise<unknown> {
			calls.push({ operation, input });
			if (operation !== "metrics.usage_series") throw new Error(`unexpected operation ${operation}`);
			const inWindow = (event: RawEvent) => event.observedAt >= input.since && event.observedAt <= input.until;
			const matching = source.filter(inWindow);
			const scopes = [...new Set(matching.map((event) => event.scope))].sort();
			const scopeLimit: number = input.scopeLimit ?? scopes.length;
			const truncated = scopes.length > scopeLimit;
			const allowedScopes = new Set(scopes.slice(0, scopeLimit));
			const window: UsageBucketWindow = { start: input.since, end: input.until, bucketCount: input.bucketCount, bucketSizeMs: input.bucketSizeMs };
			const rows = aggregate(matching.filter((event) => allowedScopes.has(event.scope)), window);
			return { rows, truncated };
		},
	};
}

describe("usage graph projection", () => {
	it("uses explicit periods, buckets aggregated token sums, and preserves provider/model series", () => {
		expect(USAGE_PERIODS.map(({ id, label }) => [id, label])).toEqual([
			["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["quarterly", "Quarterly"],
		]);
		const window = resolveUsageWindow("daily", now, 4);
		const chart = buildUsageGraph(aggregate(events, window), window, { period: "daily" });
		expect(chart.totalTokens).toBe(18_000);
		expect(chart.buckets.map((bucket) => bucket.total)).toEqual([10_000, 0, 5_000, 3_000]);
		expect(chart.series.map((series) => [series.provider, series.model, series.total])).toEqual([
			["openai-codex", "gpt-5.6-sol", 13_000],
			["openrouter", "openai/gpt-4.1-mini", 5_000],
		]);
		expect(chart.breakdown).toEqual({ input: 12_000, output: 3_000, cacheRead: 3_000, cacheWrite: 0 });
	});

	it("does not silently drop a heavy scope's own older history the way a per-scope row cap once did", () => {
		// Real incident: a scope logging thousands of rows/day exhausted a 250-row-per-scope cap
		// within minutes, so a "weekly" chart silently became "the last few minutes" for that scope
		// -- older buckets read as zero even though real usage happened. Aggregation must represent
		// every bucket regardless of how many raw events fed it: 10,000 tiny events spread evenly
		// across a week must show up as 10,000 tiny events spread evenly, not truncated to a tail.
		const heavyScope = "anthropic-vertex:claude-sonnet-5";
		const weekly = resolveUsageWindow("weekly", now);
		const denseEvents: RawEvent[] = Array.from({ length: 10_000 }, (_, index) => ({
			observedAt: weekly.start + Math.floor((index / 10_000) * (weekly.end - weekly.start)),
			scope: heavyScope,
			metric: "input-tokens",
			value: 10,
		}));
		const chart = buildUsageGraph(aggregate(denseEvents, weekly), weekly, { period: "weekly" });
		expect(chart.totalTokens).toBe(100_000);
		// Every one of the 28 weekly buckets has real data -- nothing got pushed out by a row cap.
		expect(chart.buckets.every((bucket) => bucket.total > 0)).toBe(true);
		expect(chart.buckets[0]!.total).toBeGreaterThan(0);
		expect(chart.buckets.at(-1)!.total).toBeGreaterThan(0);
	});
});

describe("cost graph projection", () => {
	it("buckets already-recorded per-message cost by time and provider/model, ignoring token rows", () => {
		const rows: RawEvent[] = [
			{ observedAt: now - 20 * hour, scope: "openai-codex:gpt-5.6-sol", metric: "cost", value: 0.12 },
			{ observedAt: now - 8 * hour, scope: "openrouter:openai/gpt-4.1-mini", metric: "cost", value: 0.03 },
			{ observedAt: now - 8 * hour, scope: "openrouter:openai/gpt-4.1-mini", metric: "input-tokens", value: 4_000 },
		];
		const window = resolveUsageWindow("daily", now, 4);
		const chart = buildCostGraph(aggregate(rows, window), window, { period: "daily" });
		expect(chart.totalUsd).toBeCloseTo(0.15);
		expect(chart.series.map((series) => [series.provider, series.model, series.total])).toEqual([
			["openai-codex", "gpt-5.6-sol", 0.12],
			["openrouter", "openai/gpt-4.1-mini", 0.03],
		]);
	});

	it("ignores negative or non-numeric cost sums without throwing", () => {
		const window = resolveUsageWindow("daily", now, 4);
		const rows: UsageAggregateRow[] = [
			{ scope: "openai-codex:gpt-5.6-sol", metric: "cost", bucketIndex: 0, sum: -1 },
			{ scope: "openai-codex:gpt-5.6-sol", metric: "cost", bucketIndex: 1, sum: Number.NaN },
		];
		expect(() => buildCostGraph(rows, window, { period: "daily" })).not.toThrow();
		expect(buildCostGraph(rows, window, { period: "daily" }).totalUsd).toBe(0);
	});

	it("ignores a bucketIndex outside the window instead of throwing or corrupting another bucket", () => {
		const window = resolveUsageWindow("daily", now, 4);
		const rows: UsageAggregateRow[] = [{ scope: "openai-codex:gpt-5.6-sol", metric: "cost", bucketIndex: 99, sum: 5 }];
		const chart = buildCostGraph(rows, window, { period: "daily" });
		expect(chart.totalUsd).toBe(0);
	});
});

describe("usage graph TUI", () => {
	it("exposes usage through its own dedicated /usage command, separate from /jittor", async () => {
		// Command dispatch calls showUsagePanel with the real Date.now(), not the fixed test `now`
		// constant, so this fixture must actually be recent (unlike the other tests below, which pass
		// an explicit `now` to showUsagePanel directly and can use the fixed constant).
		const recentEvents: RawEvent[] = [{ observedAt: Date.now() - 60_000, scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 8_000 }];
		const commands = new Map<string, unknown>();
		const fake = fakePiClient(recentEvents);
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
		expect(fake.calls.map((call) => call.operation)).toEqual(["metrics.usage_series"]);
		expect(fake.calls[0]?.input.source).toBe("pi");
		expect(notifications.join("\n")).toContain("Hourly token usage");
		notifications.length = 0;
		await command.handler("cost", {
			mode: "print",
			ui: { notify(message: string) { notifications.push(message); } },
		} as unknown as ExtensionCommandContext);
		expect(notifications.join("\n")).toContain("Hourly cost");
	});

	it("opens directly into the cost view when requested, independent of command dispatch", async () => {
		const fake = fakePiClient(events);
		const notifications: string[] = [];
		const ctx = { mode: "print", ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
		const budgets = { getUsageTokenBudget: () => undefined };
		await showUsagePanel(ctx, fake, budgets, now, "cost");
		expect(notifications.join("\n")).toContain("Hourly cost");
	});

	it("reports the daemon's own truncation (scope-count cap only) rather than a per-scope row cap that no longer exists", async () => {
		// Real-world shape: one scope logs heavily, another logs a single row, both inside the same
		// window. With SQL-side aggregation, neither one's history is at risk -- only exceeding the
		// bounded *distinct scope* discovery could ever truncate now.
		const heavyScope: RawEvent[] = Array.from({ length: 5_000 }, (_, index) => ({
			observedAt: now - 50 * 60_000 + index, scope: "anthropic-vertex:claude-sonnet-5", metric: "input-tokens", value: 10,
		}));
		const otherScope: RawEvent[] = [{ observedAt: now - 55 * 60_000, scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 8_000 }];
		const fake = fakePiClient([...heavyScope, ...otherScope]);
		const notifications: string[] = [];
		const ctx = { mode: "print", ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
		const budgets = { getUsageTokenBudget: () => undefined };
		await showUsagePanel(ctx, fake, budgets, now, "tokens");
		expect(fake.calls).toHaveLength(1);
		const rendered = notifications.join("\n");
		expect(rendered).not.toContain("query limit reached");
		// Both scopes' totals survive in full -- the heavy one is not capped to a recent tail.
		expect(rendered).toContain("anthropic-vertex/claude-sonnet-5");
		expect(rendered).toContain("openai-codex/gpt-5.6-sol");
		expect(rendered).toContain("50k");
	});

	it("renders a bounded cumulative graph with an honest configured threshold and over-budget state", () => {
		const window = resolveUsageWindow("daily", now, 4);
		const chart = buildUsageGraph(aggregate(events, window), window, { period: "daily" });
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
		const twoModelEvents: RawEvent[] = [
			{ observedAt: now - 10 * hour, scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 4_000 },
			{ observedAt: now - 4 * hour, scope: "openrouter:openai/gpt-4.1-mini", metric: "input-tokens", value: 2_000 },
		];
		const window = resolveUsageWindow("daily", now, 4);
		const chart = buildUsageGraph(aggregate(twoModelEvents, window), window, { period: "daily" });
		expect(chart.series).toHaveLength(2);
		const colorCalls: string[] = [];
		const theme = { fg: (color: string, text: string) => { colorCalls.push(color); return text; }, bold: (text: string) => text };
		renderUsageGraph(chart, 72, theme, undefined);
		const seriesColorsUsed = new Set(colorCalls.filter((color) => color !== "borderMuted" && color !== "muted"));
		expect(seriesColorsUsed.size).toBeGreaterThan(1);
		for (const statusColor of ["success", "warning", "error"]) expect(seriesColorsUsed.has(statusColor)).toBe(false);
	});

	it("renders a single-model chart with exactly one series color, since there is nothing to distinguish", () => {
		const window = resolveUsageWindow("daily", now, 4);
		const oneModel = aggregate([{ observedAt: now - 4 * hour, scope: "openai-codex:gpt-5.6-sol", metric: "input-tokens", value: 4_000 }], window);
		const chart = buildUsageGraph(oneModel, window, { period: "daily" });
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
		const window = resolveUsageWindow("daily", now, 4);
		const chart = buildUsageGraph(aggregate(events, window), window, { period: "daily" });
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		expect(renderUsageGraph(chart, 72, theme, 20_000).join("\n")).toContain("2k remaining");
		const unconfigured = renderUsageGraph(chart, 72, theme).join("\n");
		expect(unconfigured).toContain("budget not configured");
		expect(unconfigured).not.toContain("OVER BUDGET");
		const truncated = buildUsageGraph(aggregate(events, window), window, { period: "daily", truncated: true });
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
		registerJittorExtension({ registerCommand(name: string, command: unknown) { commands.set(name, command); }, on() {} } as unknown as ExtensionAPI, { async call() { return { rows: [], truncated: false }; } }, control);
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
		const client = fakePiClient(events);
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

	it("queries only the daemon's aggregated usage series and supports period changes", async () => {
		const client = fakePiClient(events);
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
		// One "metrics.usage_series" call per period shown (Hourly, then Daily) -- a single bounded
		// round trip each, not a distinct_scopes call plus one metrics.query per discovered scope.
		expect(client.calls).toHaveLength(2);
		expect(client.calls.every((call) => call.operation === "metrics.usage_series")).toBe(true);
		expect(client.calls.every((call) => call.input.source === "pi")).toBe(true);
		expect(client.calls.map((call) => call.input.since)).toEqual([now - hour, now - 24 * hour]);
	});
});
