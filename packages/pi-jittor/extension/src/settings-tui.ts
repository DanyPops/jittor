import { USAGE_PERIODS, type UsagePeriod } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, Menu, type MenuTheme, type TextMeasure } from "malevich-tui-components";
import { AUTO_MODE_SETTINGS, type AutoModeSetting } from "./optimization/auto-mode.ts";
import type { AutoModeControl, CodexRecoveryControl, EnforcementControl, UsageBudgetControl } from "./settings.ts";
import { showConfirmDialog } from "./tui-prompts.ts";

export interface SettingsSnapshot {
	enforcementEnabled: boolean;
	footerEnabled: boolean;
	codexRecoveryEnabled: boolean;
	usageTokenBudgets: Partial<Record<UsagePeriod, number>>;
	autoMode: AutoModeSetting;
	autoModeVerbose: boolean;
}

interface SettingsTheme {
	fg(color: "accent" | "success" | "warning" | "error" | "muted" | "dim" | "borderMuted", text: string): string;
	bold(text: string): string;
}

export type SettingsKey = "enforcement" | "auto-mode" | "auto-mode-verbose" | "footer" | "recovery" | `budget-${UsagePeriod}`;
export type SettingsAction = { kind: "activate"; key: SettingsKey } | { kind: "close" };

export interface SettingsEffects {
	setEnforcement(enabled: boolean): void | Promise<void>;
	setFooter(enabled: boolean): void | Promise<void>;
	setRecovery(enabled: boolean): void | Promise<void>;
	setAutoMode(mode: AutoModeSetting): void | Promise<void>;
	setAutoModeVerbose(verbose: boolean): void | Promise<void>;
}

// Enforcement -> Routing -> Budget -> Providers -> UI: safety posture (the global kill-switch
// everything else is downstream of) leads, followed by effort-based Auto mode (a routing
// behavior, not a safety switch, but consequential enough to sit right after Enforcement), then
// spend limits, then provider-specific quirks (today, only Codex recovery -- grouped under its
// own header instead of sitting flat next to global switches, which read as "too Codex-oriented"
// with nothing to signal its narrower scope), then display preferences last.
const SETTINGS_KEYS: SettingsKey[] = [
	"enforcement",
	"auto-mode",
	"auto-mode-verbose",
	...USAGE_PERIODS.map(({ id }) => `budget-${id}` as const),
	"recovery",
	"footer",
];

type SettingsCategory = "Enforcement" | "Routing" | "Budget" | "Providers" | "UI";

function categoryOf(key: SettingsKey): SettingsCategory {
	if (key === "enforcement") return "Enforcement";
	if (key === "auto-mode" || key === "auto-mode-verbose") return "Routing";
	if (key === "recovery") return "Providers";
	if (key === "footer") return "UI";
	return "Budget";
}

function state(enabled: boolean, theme: SettingsTheme): string {
	return enabled ? theme.fg("success", "ON") : theme.fg("muted", "OFF");
}

function budgetLabel(period: UsagePeriod, snapshot: SettingsSnapshot): string {
	const value = snapshot.usageTokenBudgets[period];
	return value === undefined ? "not configured" : `${value.toLocaleString()} tokens`;
}

function autoModeLabel(mode: AutoModeSetting, theme: SettingsTheme): string {
	if (mode === "off") return theme.fg("muted", "OFF");
	if (mode === "auto-switch") return theme.fg("success", "AUTO-SWITCH");
	return theme.fg("accent", "SUGGEST");
}

function rowText(key: SettingsKey, snapshot: SettingsSnapshot, theme: SettingsTheme): string {
	if (key === "enforcement") return `Routing enforcement  ${state(snapshot.enforcementEnabled, theme)}`;
	if (key === "auto-mode") return `Auto mode  ${autoModeLabel(snapshot.autoMode, theme)}`;
	if (key === "auto-mode-verbose") return `Suggestion details  ${state(snapshot.autoModeVerbose, theme)}`;
	if (key === "footer") return `Informational footer  ${state(snapshot.footerEnabled, theme)}`;
	if (key === "recovery") return `Codex recovery  ${state(snapshot.codexRecoveryEnabled, theme)}`;
	const period = key.slice("budget-".length) as UsagePeriod;
	return `${USAGE_PERIODS.find((candidate) => candidate.id === period)!.label} token budget  ${budgetLabel(period, snapshot)}`;
}

export function settingsSnapshot(
	enforcement: EnforcementControl,
	recovery: CodexRecoveryControl,
	budgets: UsageBudgetControl,
	autoMode: AutoModeControl,
): SettingsSnapshot {
	return {
		enforcementEnabled: enforcement.isEnabled(),
		footerEnabled: enforcement.isFooterEnabled(),
		codexRecoveryEnabled: recovery.isCodexRecoveryEnabled(),
		usageTokenBudgets: Object.fromEntries(USAGE_PERIODS.map(({ id }) => [id, budgets.getUsageTokenBudget(id)])),
		autoMode: autoMode.getAutoMode(),
		autoModeVerbose: autoMode.isAutoModeVerbose(),
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

/**
 * Wraps `menu` (already built over `SETTINGS_KEYS` in order, with no `title` of its own) so its
 * rendered output gets a non-selectable category header line inserted before each contiguous run
 * of same-category rows. `Menu` has no native header/divider item type, and keeps its selected
 * index private with no getter, so headers are inserted into the *rendered lines*, never built as
 * extra selectable items -- `menu`'s own input handling, selection state, and every existing
 * keybinding stay completely untouched; this only changes what gets displayed.
 *
 * With no `title` set, `Menu.render` always returns exactly `[rule, ...itemLines, rule]` (see
 * malevich-tui-components' Menu/renderFramedPanel). If that ever stops holding -- a future
 * malevich release changing Menu's own frame shape -- this falls back to Menu's unmodified
 * output rather than slicing the wrong lines into a garbled view.
 */
function groupedSettingsMenu(
	menu: Menu,
	theme: SettingsTheme,
): { invalidate(): void; handleInput(data: string): void; render(width: number): string[] } {
	return {
		invalidate: () => menu.invalidate(),
		handleInput: (data: string) => menu.handleInput(data),
		render(width: number): string[] {
			const rendered = menu.render(width);
			if (rendered.length !== SETTINGS_KEYS.length + 2) return rendered;
			const itemLines = rendered.slice(1, 1 + SETTINGS_KEYS.length);
			const out: string[] = [rendered[0]!];
			let lastCategory: SettingsCategory | undefined;
			for (const [index, key] of SETTINGS_KEYS.entries()) {
				const category = categoryOf(key);
				if (category !== lastCategory) {
					if (lastCategory !== undefined) out.push("");
					out.push(theme.bold(theme.fg("dim", category)));
					lastCategory = category;
				}
				out.push(itemLines[index]!);
			}
			out.push(rendered.at(-1)!);
			return out;
		},
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
		list: groupedSettingsMenu(menu, theme),
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
	autoMode: AutoModeControl,
): Promise<void> {
	if (action.kind === "close") return;
	if (action.key === "auto-mode") {
		const current = autoMode.getAutoMode();
		const next = AUTO_MODE_SETTINGS[(AUTO_MODE_SETTINGS.indexOf(current) + 1) % AUTO_MODE_SETTINGS.length]!;
		// Entering the highest-autonomy state gets the same explicit confirmation Codex recovery's
		// own opt-in already gets; leaving it (like disabling enforcement) needs none -- becoming
		// more conservative is never something to gate behind a confirmation.
		if (next === "auto-switch") {
			if (
				await showConfirmDialog(
					ctx,
					"Enable Auto-switch?",
					"Jittor may switch your active model on its own when a turn's effort clearly calls for a different one, with no confirmation prompt.",
				)
			)
				await effects.setAutoMode(next);
		} else await effects.setAutoMode(next);
		return;
	}
	if (action.key === "auto-mode-verbose") {
		await effects.setAutoModeVerbose(!autoMode.isAutoModeVerbose());
		return;
	}
	if (action.key === "enforcement") {
		if (enforcement.isEnabled()) {
			if (
				await showConfirmDialog(
					ctx,
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
				await showConfirmDialog(
					ctx,
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
	autoMode: AutoModeControl,
	effects: SettingsEffects = {
		setEnforcement: (enabled) => enforcement.setEnabled(enabled),
		setFooter: (enabled) => enforcement.setFooterEnabled(enabled),
		setRecovery: (enabled) => recovery.setCodexRecoveryEnabled(enabled),
		setAutoMode: (mode) => autoMode.setAutoMode(mode),
		setAutoModeVerbose: (verbose) => autoMode.setAutoModeVerbose(verbose),
	},
): Promise<void> {
	if (ctx.mode !== "tui") {
		const snapshot = settingsSnapshot(enforcement, recovery, budgets, autoMode);
		ctx.ui.notify(["Jittor Settings", ...SETTINGS_KEYS.map((key) => rowText(key, snapshot, plainTheme()))].join("\n"), "info");
		return;
	}
	for (;;) {
		const snapshot = settingsSnapshot(enforcement, recovery, budgets, autoMode);
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
		await runSettingsAction(ctx, action, enforcement, recovery, budgets, effects, autoMode);
	}
}
