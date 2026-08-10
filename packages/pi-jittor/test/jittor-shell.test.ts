import { describe, expect, it } from "bun:test";
import type {
	CacheEconomicsSummary,
	ModelCandidate,
	ModelRankingResult,
	ModelTaskDomain,
	ModelTaskType,
	RouterStatus,
} from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertNoMnemonicConflicts } from "malevich-tui-components";
import { type JittorShellDeps, jittorShellMnemonicTree, showJittorShell } from "../extension/src/jittor-shell.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function settingsControl() {
	let enforcementEnabled = true;
	let footerEnabled = true;
	let codexRecoveryEnabled = false;
	const budgets: Record<string, number | undefined> = {};
	return {
		isEnabled: () => enforcementEnabled,
		setEnabled: (value: boolean) => {
			enforcementEnabled = value;
		},
		isFooterEnabled: () => footerEnabled,
		setFooterEnabled: (value: boolean) => {
			footerEnabled = value;
		},
		isCodexRecoveryEnabled: () => codexRecoveryEnabled,
		setCodexRecoveryEnabled: (value: boolean) => {
			codexRecoveryEnabled = value;
		},
		getUsageTokenBudget: (period: string) => budgets[period],
		setUsageTokenBudget: (period: string, tokens: number | undefined) => {
			budgets[period] = tokens;
		},
	};
}

const routerStatus: RouterStatus = {
	ready: true,
	paused: false,
	sources: [],
	lastDecision: null,
	override: null,
	currentRoute: { provider: "anthropic", model: "claude-sonnet-5", thinking: "high" },
	availableRoutes: [],
};

function ranking(): ModelRankingResult {
	return {
		scopeAuthority: "available-models",
		scopeWarning: null,
		domain: "coding",
		type: "general",
		completeness: "partial",
		automaticSelection: null,
		ranked: [],
	} as unknown as ModelRankingResult;
}

function cacheSummary(): CacheEconomicsSummary {
	return {
		since: 0,
		until: 1,
		models: [],
		tasks: [],
		unattributedCacheActivity: {
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheReadCostUsd: 0,
			cacheReadCostBasis: "provider-reported",
			cacheWriteCostUsd: 0,
			cacheWriteCostBasis: "provider-reported",
			catalogFreshness: null,
		},
		stablePrefixChurn: [],
		missedOpportunities: [],
		truncated: false,
	};
}

function deps(calls: Array<{ operation: string; input: unknown }>): JittorShellDeps {
	const settings = settingsControl();
	return {
		settings: {
			enforcement: settings,
			recovery: settings,
			budgets: settings,
			effects: {
				setEnforcement: async () => {},
				setFooter: async () => {},
				setRecovery: async () => {},
			},
		},
		status: {
			client: {
				async call(operation: string, input: unknown) {
					calls.push({ operation, input });
					if (operation === "router.status") return routerStatus;
					if (operation === "metrics.query") return [];
					return {};
				},
			},
		},
		benchmarks: {
			client: {
				async call(operation: string, input: unknown) {
					calls.push({ operation, input });
					return operation === "models.rank" ? ranking() : {};
				},
			},
			candidates: [] as ModelCandidate[],
			currentIdentity: "openai/gpt",
			domain: "general" as ModelTaskDomain,
			type: "general" as ModelTaskType,
		},
		cache: {
			client: {
				async call(operation: string, input: unknown) {
					calls.push({ operation, input });
					return cacheSummary();
				},
			},
			windowMs: 60_000,
			now: () => 100_000,
		},
	};
}

describe("Jittor unified /jittor shell", () => {
	it("keeps the shell's own tab-cycling/close bindings free of conflict with any single tab's own reachable bindings", () => {
		expect(() => assertNoMnemonicConflicts(jittorShellMnemonicTree())).not.toThrow();
	});

	it("falls back to each domain's own existing non-TUI notify, keyed by the requested initial tab", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const notifications: string[] = [];
		const ctx = {
			mode: "headless",
			sessionManager: { getSessionId: () => "session-1" },
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;
		await showJittorShell(ctx, deps(calls), "cache");
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("No cache activity recorded in this window.");
	});

	it("opens directly on the requested initial tab without fetching any other tab's data", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		let rendered = "";
		const ctx = {
			mode: "tui",
			sessionManager: { getSessionId: () => "session-1" },
			ui: {
				async custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput?(data: string): void }) {
					const component = factory({ requestRender() {} }, theme, {}, () => undefined);
					rendered = component.render(100).join("\n");
					return { kind: "close" };
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		await showJittorShell(ctx, deps(calls), "cache");
		expect(rendered).toContain("Cache");
		expect(calls.map((call) => call.operation)).toEqual(["cache.economics"]);
	});

	it("fetches a tab's data only once actually visited (lazy per-tab loading)", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		let panelCount = 0;
		const ctx = {
			mode: "tui",
			sessionManager: { getSessionId: () => "session-1" },
			ui: {
				async custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput?(data: string): void }) {
					panelCount += 1;
					let resolved: unknown;
					const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => {
						resolved = value;
					});
					if (panelCount === 1) {
						component.handleInput?.("\t"); // Tab -> next tab (settings -> status)
						return resolved;
					}
					return { kind: "close" };
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		await showJittorShell(ctx, deps(calls), "settings");
		expect(calls.map((call) => call.operation)).toEqual(["router.status", "metrics.query"]);
		expect(panelCount).toBe(2);
	});

	it("closes the whole shell on Escape regardless of which tab is active", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const ctx = {
			mode: "tui",
			sessionManager: { getSessionId: () => "session-1" },
			ui: {
				async custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput?(data: string): void }) {
					let resolved: unknown;
					const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => {
						resolved = value;
					});
					component.handleInput?.("\x1b");
					return resolved;
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		await showJittorShell(ctx, deps(calls), "benchmarks");
		expect(calls.map((call) => call.operation)).toEqual(["models.rank"]);
	});

	it("delegates a real key on the active tab to that domain's own side effect and re-fetches only that tab", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		let panelCount = 0;
		const ctx = {
			mode: "tui",
			sessionManager: { getSessionId: () => "session-1" },
			ui: {
				async custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput?(data: string): void }) {
					panelCount += 1;
					let resolved: unknown;
					const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => {
						resolved = value;
					});
					if (panelCount === 1) {
						component.handleInput?.("r");
						return resolved;
					}
					return { kind: "close" };
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		await showJittorShell(ctx, deps(calls), "cache");
		expect(calls.map((call) => call.operation)).toEqual(["cache.economics", "cache.economics"]);
		expect(panelCount).toBe(2);
	});
});
