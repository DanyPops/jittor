import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
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
			getCwd: () => join(homedir(), "Projects", "jittor"),
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

const weekly: ProviderBudget = {
	kind: "bounded",
	label: "W",
	remainingFraction: 0.58,
	observedAt: 1_000,
	resetsAt: 5 * 24 * 60 * 60 * 1_000 + 2_000,
};

describe("Jittor integrated footer", () => {
	it("renders repository, model, token usage, context, budget, and statuses on one unlabeled line", () => {
		const lines = renderFooterLines(context(), footerData, theme, weekly, "high", 220, 2_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("~/Projects/jittor (main)");
		expect(lines[0]).toMatch(/\(openai-codex\) gpt-5\.6-sol · high · ↑10k ↓2\.0k R8\.0k/);
		expect(lines[0]).toMatch(/ctx [█░]+ 25k\/200k/);
		expect(lines[0]).toMatch(/W █████░░░ 58.0% left · resets in 5d/);
		expect(lines[0]).toContain("Tasks · 1 active");
		expect(lines[0]).not.toMatch(/\b(?:Repo|AI|LLM|Jittor)\b/);
	});

	it("keeps context filling while the bounded provider budget drains", () => {
		const empty = renderFooterLines(context(75, 150_000), footerData, theme, { ...weekly, remainingFraction: 0.1 }, "high", 180, 2_000)[0]!;
		const full = renderFooterLines(context(25, 50_000), footerData, theme, { ...weekly, remainingFraction: 1 }, "high", 180, 2_000)[0]!;
		expect(empty).toMatch(/ctx ██████░░ 150k\/200k/);
		expect(empty).toMatch(/W █░░░░░░░ 10.0% left/);
		expect(full).toMatch(/ctx ██░░░░░░ 50k\/200k/);
		expect(full).toMatch(/W ████████ 100.0% left/);
	});

	it("colors low remaining budget as danger without changing drain direction", () => {
		colorCalls.length = 0;
		renderFooterLines(context(75, 150_000), footerData, theme, { ...weekly, remainingFraction: 0.05 }, "high", 120, 2_000);
		expect(colorCalls.some((call) => call.color === "warning" && call.text.includes("█"))).toBe(true);
		expect(colorCalls.some((call) => call.color === "error" && call.text.includes("░"))).toBe(true);
	});

	it("renders explicit unknown context and budget states", () => {
		const lines = renderFooterLines(context(null, null), footerData, theme, null, "high", 140, 2_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/ctx [░]+ \?\/200k/);
		expect(lines[0]).toMatch(/budget [░]+ \?/);
	});

	it("drains the context bar and tracks elapsed time while Pi compaction is active", () => {
		const lines = renderFooterLines(
			context(75, 150_000), footerData, theme, weekly, "high", 180, 8_000,
			{ startedAt: 2_000, initialFraction: 0.75 },
		);
		expect(lines[0]).toMatch(/ctx ████░░░░ compact 6s/);
		expect(lines[0]).not.toContain("150k/200k");
	});

	it("uses the same drain semantics for an officially bounded OpenRouter key", () => {
		const openRouter: ProviderBudget = {
			kind: "bounded", label: "OR", remainingFraction: 0.4, observedAt: 1_000, resetText: "monthly reset",
		};
		const line = renderFooterLines(context(), footerData, theme, openRouter, "high", 180, 2_000)[0]!;
		expect(line).toMatch(/OR ███░░░░░ 40.0% left · monthly reset/);
	});

	it("marks stale provider telemetry and does not invent a bar for unbounded spend", () => {
		const stale = renderFooterLines(context(), footerData, theme, weekly, "high", 140, 200_000);
		expect(stale[0]).toContain("stale");
		const spend = renderFooterLines(context(), footerData, theme, { kind: "unbounded", label: "spend", valueText: "$12.346", observedAt: 1_000 }, "high", 140, 2_000);
		expect(spend[0]).toContain("spend $12.346");
		expect(spend[0]).not.toMatch(/spend [█░]+/);
	});

	it("keeps every responsive line within narrow terminal width", () => {
		const lines = renderFooterLines(context(), footerData, theme, weekly, "high", 42, 2_000);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(42);
		expect(lines[0]).toContain("gpt-5.6-sol");
		expect(lines[0]).toContain("ctx");
		expect(lines[0]).toContain("W");
		expect(lines[0]).toContain("58% left");
		expect(lines[0]).not.toContain("resets");
	});
});
