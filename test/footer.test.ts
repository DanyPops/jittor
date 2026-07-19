import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLines, type ProviderBudget } from "../extension/src/footer.ts";

const colorCalls: Array<{ color: string; text: string }> = [];
const theme = {
	fg: (color: string, text: string) => { colorCalls.push({ color, text }); return text; },
	bold: (text: string) => text,
};

function context(percent: number | null = 12.5, tokens: number | null = 25_000) {
	return {
		model: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens, percent, contextWindow: 200_000 }),
		sessionManager: {
			getCwd: () => "/home/dpopsuev/Projects/jittor",
			getSessionName: () => undefined,
			getEntries: () => [{ type: "message", message: { role: "assistant", usage: {
				input: 10_000, output: 2_000, cacheRead: 8_000, cacheWrite: 0, cost: { total: 0 },
			} } }],
		},
	};
}

const footerData = {
	getGitBranch: () => "main",
	getAvailableProviderCount: () => 2,
	getExtensionStatuses: () => new Map([["tasks", "Tasks · 1 active"]]),
};

const weekly: ProviderBudget = { label: "weekly", fraction: 0.42, valueText: "42.0% used", observedAt: 1_000 };

describe("Jittor Alef-style integrated footer", () => {
	it("groups repository, model, context, bounded budget, and built-in usage information", () => {
		const lines = renderFooterLines(context(), footerData, theme, weekly, "high", 120, 2_000);
		expect(lines[0]).toContain("Repo ~/Projects/jittor (main)");
		expect(lines[0]).toContain("AI (openai-codex) gpt-5.6-sol · high");
		expect(lines[1]).toContain("LLM ↑10k ↓2.0k R8.0k");
		expect(lines[1]).toMatch(/ctx [█░]+ 25k\/200k/);
		expect(lines[1]).toMatch(/weekly [█░]+ 42.0% used/);
		expect(lines.join("\n")).not.toContain("Jittor");
		expect(lines[2]).toBe("Tasks · 1 active");
	});

	it("uses warning and error colors at semantic fill thresholds", () => {
		colorCalls.length = 0;
		renderFooterLines(context(75, 150_000), footerData, theme, { ...weekly, fraction: 0.95, valueText: "95.0% used" }, "high", 120, 2_000);
		expect(colorCalls.some((call) => call.color === "warning" && call.text.includes("█"))).toBe(true);
		expect(colorCalls.some((call) => call.color === "error" && call.text.includes("█"))).toBe(true);
	});

	it("renders explicit unknown context and budget states", () => {
		const lines = renderFooterLines(context(null, null), footerData, theme, null, "high", 100, 2_000);
		expect(lines[1]).toMatch(/ctx [░]+ \?\/200k/);
		expect(lines[1]).toMatch(/budget [░]+ \?/);
	});

	it("marks stale provider telemetry and does not invent a bar for unbounded spend", () => {
		const stale = renderFooterLines(context(), footerData, theme, weekly, "high", 120, 200_000);
		expect(stale[1]).toContain("stale");
		const spend = renderFooterLines(context(), footerData, theme, { label: "spend", fraction: null, valueText: "$12.346", observedAt: 1_000 }, "high", 120, 2_000);
		expect(spend[1]).toContain("spend $12.346");
		expect(spend[1]).not.toMatch(/spend [█░]+/);
	});

	it("keeps every responsive line within narrow terminal width", () => {
		const lines = renderFooterLines(context(), footerData, theme, weekly, "high", 42, 2_000);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(42);
		expect(lines.join("\n")).toContain("gpt-5.6-sol");
		expect(lines.join("\n")).toContain("ctx");
		expect(lines.join("\n")).toContain("weekly");
	});
});
