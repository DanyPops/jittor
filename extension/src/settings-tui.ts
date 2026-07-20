import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { USAGE_PERIODS, type UsagePeriod } from "../../src/domain/usage.ts";
import type { CodexRecoveryControl, EnforcementControl, UsageBudgetControl } from "./settings.ts";

export interface SettingsSnapshot {
	enforcementEnabled: boolean;
	footerEnabled: boolean;
	codexRecoveryEnabled: boolean;
	usageTokenBudgets: Partial<Record<UsagePeriod, number>>;
}

interface SettingsTheme {
	fg(color: "accent" | "success" | "warning" | "error" | "muted" | "dim" | "borderMuted", text: string): string;
	bold(text: string): string;
}

type SettingsKey = "enforcement" | "footer" | "recovery" | `budget-${UsagePeriod}`;
type SettingsAction = { kind: "activate"; key: SettingsKey } | { kind: "close" };

export interface SettingsEffects {
	setEnforcement(enabled: boolean): void | Promise<void>;
	setFooter(enabled: boolean): void | Promise<void>;
	setRecovery(enabled: boolean): void | Promise<void>;
}

const SETTINGS_KEYS: SettingsKey[] = [
	"enforcement",
	"footer",
	"recovery",
	...USAGE_PERIODS.map(({ id }) => `budget-${id}` as const),
];

function state(enabled: boolean, theme: SettingsTheme): string {
	return enabled ? theme.fg("success", "ON") : theme.fg("muted", "OFF");
}

function budgetLabel(period: UsagePeriod, snapshot: SettingsSnapshot): string {
	const value = snapshot.usageTokenBudgets[period];
	return value === undefined ? "not configured" : `${value.toLocaleString()} tokens`;
}

function rowText(key: SettingsKey, snapshot: SettingsSnapshot, theme: SettingsTheme): string {
	if (key === "enforcement") return `Routing enforcement  ${state(snapshot.enforcementEnabled, theme)}`;
	if (key === "footer") return `Informational footer  ${state(snapshot.footerEnabled, theme)}`;
	if (key === "recovery") return `Codex recovery  ${state(snapshot.codexRecoveryEnabled, theme)}`;
	const period = key.slice("budget-".length) as UsagePeriod;
	return `${USAGE_PERIODS.find((candidate) => candidate.id === period)!.label} token budget  ${budgetLabel(period, snapshot)}`;
}

export function settingsSnapshot(
	enforcement: EnforcementControl,
	recovery: CodexRecoveryControl,
	budgets: UsageBudgetControl,
): SettingsSnapshot {
	return {
		enforcementEnabled: enforcement.isEnabled(),
		footerEnabled: enforcement.isFooterEnabled(),
		codexRecoveryEnabled: recovery.isCodexRecoveryEnabled(),
		usageTokenBudgets: Object.fromEntries(USAGE_PERIODS.map(({ id }) => [id, budgets.getUsageTokenBudget(id)])),
	};
}

export function renderSettingsView(snapshot: SettingsSnapshot, selected: number, width: number, theme: SettingsTheme): string[] {
	const safeWidth = Math.max(20, width);
	const lines = [
		theme.bold("Jittor Settings"),
		theme.fg("dim", "Token budgets are user values; provider quotas remain separate."),
		"",
	];
	for (let index = 0; index < SETTINGS_KEYS.length; index += 1) {
		const selectedRow = index === selected;
		const prefix = selectedRow ? theme.fg("accent", "› ") : "  ";
		lines.push(`${prefix}${rowText(SETTINGS_KEYS[index]!, snapshot, theme)}`);
	}
	lines.push("", theme.fg("dim", "↑/↓ select · Enter edit · Esc close"));
	return lines.map((line) => visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "…"));
}

function plainTheme(): SettingsTheme {
	return { fg: (_color, text) => text, bold: (text) => text };
}

async function editBudget(ctx: ExtensionCommandContext, budgets: UsageBudgetControl, period: UsagePeriod): Promise<void> {
	const label = USAGE_PERIODS.find((candidate) => candidate.id === period)!.label;
	const current = budgets.getUsageTokenBudget(period);
	const input = await ctx.ui.input(`${label} token budget`, current?.toLocaleString() ?? "positive token count or off");
	if (input === undefined) return;
	const normalized = input.trim().toLowerCase();
	if (normalized === "off" || normalized === "clear") {
		budgets.setUsageTokenBudget(period, undefined);
		ctx.ui.notify(`${label} token budget cleared.`, "info");
		return;
	}
	const tokens = Number(normalized.replaceAll(",", ""));
	if (!Number.isFinite(tokens) || tokens <= 0) {
		ctx.ui.notify("Enter a positive token count, or `off` to clear this threshold.", "warning");
		return;
	}
	budgets.setUsageTokenBudget(period, tokens);
	ctx.ui.notify(`${label} token budget set to ${tokens.toLocaleString()} tokens.`, "info");
}

export async function showSettingsPanel(
	ctx: ExtensionCommandContext,
	enforcement: EnforcementControl,
	recovery: CodexRecoveryControl,
	budgets: UsageBudgetControl,
	effects: SettingsEffects = {
		setEnforcement: (enabled) => enforcement.setEnabled(enabled),
		setFooter: (enabled) => enforcement.setFooterEnabled(enabled),
		setRecovery: (enabled) => recovery.setCodexRecoveryEnabled(enabled),
	},
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(renderSettingsView(settingsSnapshot(enforcement, recovery, budgets), -1, 100, plainTheme()).slice(0, -2).join("\n"), "info");
		return;
	}
	for (;;) {
		const snapshot = settingsSnapshot(enforcement, recovery, budgets);
		const action = await ctx.ui.custom<SettingsAction>((tui, theme, _keybindings, done) => {
			let selected = 0;
			return {
				invalidate() {},
				render(width: number): string[] { return renderSettingsView(snapshot, selected, width, theme); },
				handleInput(data: string): void {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") done({ kind: "close" });
					else if (matchesKey(data, "up")) { selected = (selected - 1 + SETTINGS_KEYS.length) % SETTINGS_KEYS.length; tui.requestRender(); }
					else if (matchesKey(data, "down")) { selected = (selected + 1) % SETTINGS_KEYS.length; tui.requestRender(); }
					else if (matchesKey(data, "return") || matchesKey(data, "enter") || matchesKey(data, "space")) done({ kind: "activate", key: SETTINGS_KEYS[selected]! });
				},
			};
		});
		if (!action || action.kind === "close") return;
		if (action.key === "enforcement") {
			if (enforcement.isEnabled()) {
				if (await ctx.ui.confirm("Disable routing enforcement?", "Jittor will remain monitor-only and will no longer block unsafe provider requests.")) await effects.setEnforcement(false);
			} else await effects.setEnforcement(true);
			continue;
		}
		if (action.key === "footer") {
			await effects.setFooter(!enforcement.isFooterEnabled());
			continue;
		}
		if (action.key === "recovery") {
			if (!recovery.isCodexRecoveryEnabled()) {
				if (await ctx.ui.confirm("Enable Codex recovery?", "Jittor may start bounded hidden retries only after transient Codex failures fully settle.")) await effects.setRecovery(true);
			} else await effects.setRecovery(false);
			continue;
		}
		await editBudget(ctx, budgets, action.key.slice("budget-".length) as UsagePeriod);
	}
}
