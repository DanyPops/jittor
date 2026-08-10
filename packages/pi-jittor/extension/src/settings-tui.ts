import { USAGE_PERIODS, type UsagePeriod } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, Menu, type MenuTheme, type TextMeasure } from "malevich-tui-components";
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

export type SettingsKey = "enforcement" | "footer" | "recovery" | `budget-${UsagePeriod}`;
export type SettingsAction = { kind: "activate"; key: SettingsKey } | { kind: "close" };

export interface SettingsEffects {
	setEnforcement(enabled: boolean): void | Promise<void>;
	setFooter(enabled: boolean): void | Promise<void>;
	setRecovery(enabled: boolean): void | Promise<void>;
}

const SETTINGS_KEYS: SettingsKey[] = ["enforcement", "footer", "recovery", ...USAGE_PERIODS.map(({ id }) => `budget-${id}` as const)];

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

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

function menuTheme(theme: SettingsTheme): MenuTheme {
	return {
		border: () => "",
		selected: (text) => theme.fg("accent", text),
		normal: (text) => text,
		dim: (text) => theme.fg("dim", text),
		title: theme.bold,
	};
}

/** Defaults to a full-chrome standalone panel (`framed: true`); pass `framed: false` when nesting this as one tab's content inside another framed container (e.g. the unified /jittor shell's own outer border). */
export function createSettingsPanel(
	snapshot: SettingsSnapshot,
	theme: SettingsTheme,
	onAction: (action: SettingsAction) => void,
	selected = 0,
	framed = true,
): BorderedSelectPanel {
	const menu = new Menu({
		items: SETTINGS_KEYS.map((key) => ({ label: rowText(key, snapshot, theme), action: () => onAction({ kind: "activate", key }) })),
		theme: menuTheme(theme),
		onClose: () => onAction({ kind: "close" }),
		measure: hostTextMeasure,
		matchesKey: (data, key) => {
			if (key === "enter") return matchesKey(data, "enter") || matchesKey(data, "space");
			if (key === "escape") return matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
			if (key === "up") return matchesKey(data, "up");
			if (key === "down") return matchesKey(data, "down");
			return false;
		},
	});
	for (let index = 0; index < selected; index += 1) menu.handleInput("\x1b[B");
	return new BorderedSelectPanel({
		title: "Jittor Settings",
		list: menu,
		helpText: "Token budgets are user values; provider quotas remain separate. · ↑/↓ select · Enter edit · Esc close",
		theme: {
			border: (text) => theme.fg("borderMuted", text),
			title: theme.bold,
			help: (text) => theme.fg("dim", text),
		},
		measure: hostTextMeasure,
		framed,
	});
}

export function renderSettingsView(snapshot: SettingsSnapshot, selected: number, width: number, theme: SettingsTheme): string[] {
	return createSettingsPanel(snapshot, theme, () => undefined, Math.max(0, selected)).render(Math.max(20, width));
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
		await budgets.setUsageTokenBudget(period, undefined);
		ctx.ui.notify(`${label} token budget cleared.`, "info");
		return;
	}
	const tokens = Number(normalized.replaceAll(",", ""));
	if (!Number.isFinite(tokens) || tokens <= 0) {
		ctx.ui.notify("Enter a positive token count, or `off` to clear this threshold.", "warning");
		return;
	}
	await budgets.setUsageTokenBudget(period, tokens);
	ctx.ui.notify(`${label} token budget set to ${tokens.toLocaleString()} tokens.`, "info");
}

/**
 * Performs the real side effect for one resolved settings action -- confirmations, effects calls,
 * budget prompts. A no-op for "close". Shared by the standalone settings panel below and the
 * unified /jittor shell, so the two interactive surfaces can never drift apart.
 */
export async function runSettingsAction(
	ctx: ExtensionCommandContext,
	action: SettingsAction,
	enforcement: EnforcementControl,
	recovery: CodexRecoveryControl,
	budgets: UsageBudgetControl,
	effects: SettingsEffects,
): Promise<void> {
	if (action.kind === "close") return;
	if (action.key === "enforcement") {
		if (enforcement.isEnabled()) {
			if (
				await ctx.ui.confirm(
					"Disable routing enforcement?",
					"Jittor will remain monitor-only and will no longer block unsafe provider requests.",
				)
			)
				await effects.setEnforcement(false);
		} else await effects.setEnforcement(true);
		return;
	}
	if (action.key === "footer") {
		await effects.setFooter(!enforcement.isFooterEnabled());
		return;
	}
	if (action.key === "recovery") {
		if (!recovery.isCodexRecoveryEnabled()) {
			if (
				await ctx.ui.confirm(
					"Enable Codex recovery?",
					"Jittor may start bounded hidden retries only after transient Codex failures fully settle.",
				)
			)
				await effects.setRecovery(true);
		} else await effects.setRecovery(false);
		return;
	}
	await editBudget(ctx, budgets, action.key.slice("budget-".length) as UsagePeriod);
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
		const snapshot = settingsSnapshot(enforcement, recovery, budgets);
		ctx.ui.notify(["Jittor Settings", ...SETTINGS_KEYS.map((key) => rowText(key, snapshot, plainTheme()))].join("\n"), "info");
		return;
	}
	for (;;) {
		const snapshot = settingsSnapshot(enforcement, recovery, budgets);
		const action = await ctx.ui.custom<SettingsAction>((tui, theme, _keybindings, done) => {
			const panel = createSettingsPanel(snapshot, theme, done);
			return {
				invalidate: () => panel.invalidate(),
				render: (width) => panel.render(width),
				handleInput(data: string) {
					panel.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!action || action.kind === "close") return;
		await runSettingsAction(ctx, action, enforcement, recovery, budgets, effects);
	}
}
