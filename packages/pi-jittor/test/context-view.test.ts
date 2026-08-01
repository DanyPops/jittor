import { describe, expect, it } from "bun:test";
import type { ContextSegment } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ContextBreakdown } from "../extension/src/context-breakdown.ts";
import { showContextView } from "../extension/src/context-view.ts";

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
					rendered = component.render(60).join("\n");
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showContextView(ctx, breakdown({ totalTokens: 12_000, contextWindow: 200_000, effectiveBudget: 200_000 }));
		expect(rendered).toContain("Context");
		expect(rendered).toContain("12.0k");
		expect(rendered.indexOf("Active Rules")).toBeLessThan(rendered.indexOf("Tool definitions"));
		expect(rendered).toContain("[exact-cooperative]");
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
