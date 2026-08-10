import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PersistentExtensionControl } from "../extension/src/settings.ts";
import { renderSettingsView, type SettingsSnapshot, showSettingsPanel } from "../extension/src/settings-tui.ts";

const snapshot: SettingsSnapshot = {
	enforcementEnabled: true,
	footerEnabled: true,
	codexRecoveryEnabled: false,
	usageTokenBudgets: { hourly: 25_000, daily: undefined, weekly: 750_000, monthly: 2_000_000 },
};

function control(): PersistentExtensionControl & { values: SettingsSnapshot } {
	const values = structuredClone(snapshot);
	return {
		values,
		isEnabled: () => values.enforcementEnabled,
		setEnabled(value) {
			values.enforcementEnabled = value;
		},
		isFooterEnabled: () => values.footerEnabled,
		setFooterEnabled(value) {
			values.footerEnabled = value;
		},
		isCodexRecoveryEnabled: () => values.codexRecoveryEnabled,
		setCodexRecoveryEnabled(value) {
			values.codexRecoveryEnabled = value;
		},
		getUsageTokenBudget(period) {
			return values.usageTokenBudgets[period];
		},
		setUsageTokenBudget(period, tokens) {
			values.usageTokenBudgets[period] = tokens;
		},
	};
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("Jittor settings TUI", () => {
	it("renders every persistent control with textual states within narrow widths", () => {
		const lines = renderSettingsView(snapshot, 0, 40, theme);
		const text = lines.join("\n");
		expect(text).toContain("Routing enforcement");
		expect(text).toContain("Informational footer");
		expect(text).toContain("Codex recovery");
		for (const label of ["Hourly", "Daily", "Weekly", "Monthly"]) expect(text).toContain(label);
		expect(text).toContain("ON");
		expect(text).toContain("OFF");
		expect(text).toContain("not configured");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it("groups rows under Enforcement/Budget/Providers/UI category headers, in that order, so a single provider-specific row never reads as a peer of a global switch", () => {
		const lines = renderSettingsView(snapshot, 0, 60, theme);
		const text = lines.join("\n");
		for (const header of ["Enforcement", "Budget", "Providers", "UI"]) expect(text).toContain(header);
		const indexOf = (needle: string) => lines.findIndex((line) => line.includes(needle));
		const enforcementHeader = indexOf("Enforcement");
		const budgetHeader = indexOf("Budget");
		const providersHeader = indexOf("Providers");
		const uiHeader = indexOf("UI");
		// Category headers appear in priority order (safety, then money, then provider quirks, then
		// display), and each real row appears strictly after its own category's header.
		expect(enforcementHeader).toBeLessThan(budgetHeader);
		expect(budgetHeader).toBeLessThan(providersHeader);
		expect(providersHeader).toBeLessThan(uiHeader);
		expect(indexOf("Routing enforcement")).toBeGreaterThan(enforcementHeader);
		expect(indexOf("Routing enforcement")).toBeLessThan(budgetHeader);
		expect(indexOf("Hourly")).toBeGreaterThan(budgetHeader);
		expect(indexOf("Codex recovery")).toBeGreaterThan(providersHeader);
		expect(indexOf("Codex recovery")).toBeLessThan(uiHeader);
		expect(indexOf("Informational footer")).toBeGreaterThan(uiHeader);
	});

	it("delegates navigation and activation to the Malevich menu", async () => {
		const settings = control();
		let panels = 0;
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					let result: unknown;
					const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => {
						result = value;
					});
					if (panels++ === 0) {
						// Footer is now the last row (Enforcement -> Budget -> Providers -> UI order) --
						// seven real rows precede it (enforcement, 5x budget, recovery).
						for (let i = 0; i < 7; i += 1) component.handleInput("\x1b[B");
						component.handleInput("\r");
					} else component.handleInput("\x1b");
					return result;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showSettingsPanel(ctx, settings, settings, settings);
		expect(settings.values.footerEnabled).toBe(false);
		expect(panels).toBe(2);
	});

	it("requires confirmation for weaker enforcement and recovery changes", async () => {
		const settings = control();
		const actions = [{ kind: "activate", key: "enforcement" }, { kind: "activate", key: "recovery" }, { kind: "close" }];
		const confirmations: string[] = [];
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					const component = factory({ requestRender() {} }, theme, {}, () => undefined);
					expect(component.render(60).join("\n")).toContain("Jittor Settings");
					return actions.shift();
				},
				async confirm(title: string) {
					confirmations.push(title);
					return title.includes("recovery");
				},
			},
		} as unknown as ExtensionCommandContext;
		await showSettingsPanel(ctx, settings, settings, settings);
		expect(settings.values.enforcementEnabled).toBe(true);
		expect(settings.values.codexRecoveryEnabled).toBe(true);
		expect(confirmations).toEqual(["Disable routing enforcement?", "Enable Codex recovery?"]);
	});

	it("edits and clears user token budgets without touching provider quotas", async () => {
		const settings = control();
		const actions = [{ kind: "activate", key: "budget-daily" }, { kind: "activate", key: "budget-hourly" }, { kind: "close" }];
		const inputs = ["300,000", "off"];
		const ctx = {
			mode: "tui",
			ui: {
				async custom() {
					return actions.shift();
				},
				async input() {
					return inputs.shift();
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		await showSettingsPanel(ctx, settings, settings, settings);
		expect(settings.values.usageTokenBudgets.daily).toBe(300_000);
		expect(settings.values.usageTokenBudgets.hourly).toBeUndefined();
	});
});
