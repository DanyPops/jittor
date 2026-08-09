import { describe, expect, it } from "bun:test";
import type { ContextSegment, ContextSegmentItem } from "@danypops/jittor";
import { renderToTerminal } from "@danypops/pi-tui-harness";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ContextBreakdown } from "../extension/src/observability/context-breakdown.ts";
import { buildContextRowsIterative } from "../extension/src/observability/context-report.ts";
import { filterContextRows, showContextView } from "../extension/src/observability/context-view.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const SEGMENTS: ContextSegment[] = [
	{
		key: "toolDefinitions",
		label: "Tool definitions",
		estimatedTokens: 500,
		confidence: "exact-tool",
		items: [{ label: "builtin (4 tools)", estimatedTokens: 500 }],
	},
	{ key: "rules", label: "Active Rules", estimatedTokens: 1_200, confidence: "exact-cooperative" },
];

function breakdown(overrides: Partial<ContextBreakdown> = {}): ContextBreakdown {
	return { totalTokens: null, contextWindow: null, effectiveBudget: null, overshootTokens: 0, segments: SEGMENTS, ...overrides };
}

describe("buildContextRowsIterative", () => {
	it("flattens a realistic deeply linear session tree without recursive stack overflow", () => {
		const root: ContextSegmentItem = { label: "turn 0", estimatedTokens: 1 };
		let leaf = root;
		for (let index = 1; index < 10_000; index++) {
			const child: ContextSegmentItem = { label: `turn ${index}`, estimatedTokens: 1 };
			leaf.children = [child];
			leaf = child;
		}
		const rows = buildContextRowsIterative([{ key: "history", label: "History", estimatedTokens: 10_000, items: [root] }]);
		expect(rows).toHaveLength(10_001);
		expect(rows.at(-1)!.depth).toBe(10_000);
	});
});

describe("filterContextRows", () => {
	const rows = [
		{ key: "messageHistory", isHeader: true, depth: 0, text: "Conversation — 1000 tok (100.0%)" },
		{ key: "messageHistory", isHeader: false, depth: 1, text: "   700 tok  user: active" },
		{ key: "messageHistory", isHeader: false, depth: 2, text: "   650 tok  assistant: abandoned (inactive branch)" },
		{ key: "messageHistory", isHeader: false, depth: 3, text: "   600 tok  tool output" },
		{ key: "messageHistory", isHeader: false, depth: 2, text: "    50 tok  assistant: current" },
	];

	it("preserves ancestors for search matches", () => {
		const filtered = filterContextRows(rows, "tool output", "all", 0);
		expect(filtered.map((row) => row.text)).toEqual([rows[0]!.text, rows[1]!.text, rows[2]!.text, rows[3]!.text]);
	});

	it("filters active versus historical subtrees and supports minimum token thresholds", () => {
		expect(filterContextRows(rows, "", "historical", 0).map((row) => row.text)).toEqual([
			rows[0]!.text,
			rows[1]!.text,
			rows[2]!.text,
			rows[3]!.text,
		]);
		expect(filterContextRows(rows, "", "active", 100).map((row) => row.text)).toEqual([rows[0]!.text, rows[1]!.text]);
	});
});

describe("showContextView", () => {
	it("falls back to a plain-text notify in non-TUI mode", async () => {
		const notifications: string[] = [];
		const ctx = {
			mode: "print",
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		} as unknown as ExtensionCommandContext;
		await showContextView(ctx, breakdown({ totalTokens: 12_000, contextWindow: 200_000, effectiveBudget: 200_000 }));
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("Real usage: 12.0k / 200.0k tokens (6.0% of usable budget)");
		expect(notifications[0]).toContain("Active Rules [exact-cooperative]");
	});

	it("renders an interactive scrollable viewport in TUI mode, heaviest segment first", async () => {
		let rendered = "";
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					const component = factory({ requestRender() {} }, theme, {}, () => undefined);
					const terminal = await renderToTerminal(component.render(60));
					rendered = terminal.plainLines().join("\n");
					terminal.dispose();
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showContextView(ctx, breakdown({ totalTokens: 12_000, contextWindow: 200_000, effectiveBudget: 200_000 }));
		expect(rendered).toContain("Context");
		expect(rendered).toContain("12.0k");
		expect(rendered.indexOf("Active Rules")).toBeLessThan(rendered.indexOf("Tool definitions"));
		expect(rendered).toContain("[exact-cooperative]");
		expect(rendered).toContain("model tokenizer");
		expect(rendered).toContain("provider request totals remain aggregate");
		expect(rendered).toContain("esc close");
	});

	it("shows an overshoot warning line when known segments exceed the real total", async () => {
		let rendered = "";
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					const component = factory({ requestRender() {} }, theme, {}, () => undefined);
					rendered = component.render(60).join("\n");
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showContextView(ctx, breakdown({ totalTokens: 100, contextWindow: 200_000, effectiveBudget: 200_000, overshootTokens: 1_600 }));
		expect(rendered).toContain("Estimates exceed real total by ~1600 tok");
	});

	it("supports live search, scope cycling, and minimum-token filtering", async () => {
		let searched = "";
		let filtered = "";
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					const component = factory({ requestRender() {} }, theme, {}, () => undefined);
					component.handleInput("/");
					for (const character of "rules") component.handleInput(character);
					searched = component.render(100).join("\n");
					component.handleInput("\r");
					component.handleInput("f");
					component.handleInput("m");
					filtered = component.render(100).join("\n");
				},
			},
		} as unknown as ExtensionCommandContext;
		await showContextView(ctx, breakdown());
		expect(searched).toContain("Search: rules");
		expect(searched).toContain("Active Rules");
		expect(searched).not.toContain("Tool definitions [exact-tool]");
		expect(filtered).toContain("scope: active · min: 100 tok");
	});

	it("scrolls down on the down key and closes on escape, without throwing", async () => {
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					let closed = false;
					const component = factory({ requestRender() {} }, theme, {}, () => {
						closed = true;
					});
					component.handleInput("\x1b[B"); // down
					component.handleInput("\x1b"); // escape
					expect(closed).toBe(true);
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showContextView(ctx, breakdown());
	});
});
