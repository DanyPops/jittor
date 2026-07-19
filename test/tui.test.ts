import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildStatusView, showJittorPanel, type JittorPanelClient } from "../extension/src/tui.ts";
import type { RouterStatus } from "../src/ports/router-controller.ts";

const status: RouterStatus = {
	ready: true,
	paused: false,
	sources: [{ id: "codex-subscription", provider: "openai-codex", ok: true, metrics: 7 }, { id: "openrouter", provider: "openrouter", ok: true, metrics: 4 }],
	lastDecision: { action: "throttle", pressure: 1.1, reason: "pressure", decidedAt: 1000, trace: [] },
	override: null,
	currentRoute: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
	availableRoutes: [],
};
const metrics = [
	{ source: "codex-subscription", scope: "codex:secondary", metric: "used-fraction", value: 0.42, unit: "ratio", observedAt: 1000, id: 1, attributes: { windowSeconds: 604_800, resetsAt: 1_800_000_000 } },
	{ source: "openrouter", scope: "key:default", metric: "usage", value: 12.3456, unit: "usd", observedAt: 1000, id: 2, attributes: {} },
] as any[];

describe("Jittor status TUI", () => {
	it("shows provider budgets, route, pressure, freshness, and next downgrade", () => {
		const text = buildStatusView(status, metrics, 1_000).join("\n");
		expect(text).toContain("Codex weekly: 42.0%");
		expect(text).not.toContain("OpenRouter spend");
		expect(text).toContain("Route: openai-codex/gpt-5.6-sol · high");
		expect(text).toContain("Pressure: 1.100 · throttle");
		expect(text).toContain("Next: lower thinking");
		expect(text).toContain("codex-subscription: fresh");
	});

	it("requires confirmation before pausing routing", async () => {
		const calls: string[] = [];
		let panels = 0;
		const client: JittorPanelClient = {
			async call(operation: string) {
				calls.push(operation);
				if (operation === "router.status") return status;
				if (operation === "metrics.query") return metrics;
				if (operation === "router.pause") return { ...status, paused: true };
				return {};
			},
		};
		const ctx = {
			mode: "tui", hasUI: true,
			ui: {
				async custom(factory: any) {
					panels += 1;
					const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, (value: string) => value);
					component.render(100);
					return panels === 1 ? "pause" : "close";
				},
				async confirm() { return true; },
				notify() {},
			},
		} as unknown as ExtensionCommandContext;

		await showJittorPanel(ctx, client);
		expect(calls).toContain("router.pause");
		expect(panels).toBe(2);
	});
});

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;
