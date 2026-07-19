import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLines } from "../extension/src/footer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function context() {
	return {
		model: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ percent: 12.5, contextWindow: 200_000 }),
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

describe("Jittor integrated footer", () => {
	it("preserves built-in footer information and appends current-provider usage to the model line", () => {
		const lines = renderFooterLines(context(), footerData, theme, "W 42.0%", "high", 110);
		expect(lines[0]).toContain("~/Projects/jittor (main)");
		expect(lines[1]).toContain("↑10k ↓2.0k R8.0k");
		expect(lines[1]).toContain("(openai-codex) gpt-5.6-sol • high • W 42.0%");
		expect(lines.join("\n")).not.toContain("Jittor");
		expect(lines[2]).toBe("Tasks · 1 active");
	});

	it("drops provider usage before core model information when width is constrained", () => {
		const lines = renderFooterLines(context(), footerData, theme, "Weekly 100.0%", "high", 42);
		expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(42);
		expect(lines[1]).toContain("gpt-5.6-sol");
	});
});
