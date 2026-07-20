import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSettingsView, showSettingsPanel, type SettingsSnapshot } from "../extension/src/settings-tui.ts";
import type { PersistentExtensionControl } from "../extension/src/settings.ts";

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
		setEnabled(value) { values.enforcementEnabled = value; },
		isFooterEnabled: () => values.footerEnabled,
		setFooterEnabled(value) { values.footerEnabled = value; },
		isCodexRecoveryEnabled: () => values.codexRecoveryEnabled,
		setCodexRecoveryEnabled(value) { values.codexRecoveryEnabled = value; },
		getUsageTokenBudget(period) { return values.usageTokenBudgets[period]; },
		setUsageTokenBudget(period, tokens) { values.usageTokenBudgets[period] = tokens; },
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

	it("requires confirmation for weaker enforcement and recovery changes", async () => {
		const settings = control();
		const actions = [
			{ kind: "activate", key: "enforcement" },
			{ kind: "activate", key: "recovery" },
			{ kind: "close" },
		];
		const confirmations: string[] = [];
		const ctx = {
			mode: "tui",
			ui: {
				async custom(factory: Function) {
					const component = factory({ requestRender() {} }, theme, {}, () => undefined);
					expect(component.render(60).join("\n")).toContain("Jittor Settings");
					return actions.shift();
				},
				async confirm(title: string) { confirmations.push(title); return title.includes("recovery"); },
			},
		} as unknown as ExtensionCommandContext;
		await showSettingsPanel(ctx, settings, settings, settings);
		expect(settings.values.enforcementEnabled).toBe(true);
		expect(settings.values.codexRecoveryEnabled).toBe(true);
		expect(confirmations).toEqual(["Disable routing enforcement?", "Enable Codex recovery?"]);
	});

	it("edits and clears user token budgets without touching provider quotas", async () => {
		const settings = control();
		const actions = [
			{ kind: "activate", key: "budget-daily" },
			{ kind: "activate", key: "budget-hourly" },
			{ kind: "close" },
		];
		const inputs = ["300,000", "off"];
		const ctx = {
			mode: "tui",
			ui: {
				async custom() { return actions.shift(); },
				async input() { return inputs.shift(); },
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		await showSettingsPanel(ctx, settings, settings, settings);
		expect(settings.values.usageTokenBudgets.daily).toBe(300_000);
		expect(settings.values.usageTokenBudgets.hourly).toBeUndefined();
	});
});
