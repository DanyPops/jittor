/**
 * Consolidates /jittor's four independent overlays (Settings, Status, Benchmarks, Cache) into one
 * Envelope-equivalent shell: a single outer BorderedSelectPanel owns the one shared border/title,
 * a TabbedContainer inside it owns the persistent tab bar and hands render/input straight to
 * whichever tab is active -- the composable primitive that replaces the old ad hoc
 * close-one-overlay-open-a-different-one pattern (see malevich-tui-components' own
 * TabbedContainer doc comment). Modeled on DanyPops/vehicle's own /safety command
 * (vehicle-safety-command.ts), the real precedent for Envelope/TabbedContainer composition in
 * this ecosystem.
 *
 * Each tab's real interactive content and side-effect handling stays owned by its existing
 * module (settings-tui.ts, observability/status.ts, optimization/model-selection-panel.ts,
 * observability/cache-economics-view.ts) via their exported `create*Panel`/`run*Action`/`fetch*`
 * functions -- this module only composes them, so the standalone single-panel entry points and
 * the unified shell can never drift apart on what a keypress actually does.
 *
 * Per-tab data is fetched lazily: only the initially requested tab (plus Settings, which reads
 * already-in-memory persisted state and costs no daemon round trip at all) is fetched before the
 * shell first opens. Switching to a tab that has never been visited fetches it once, on first
 * visit, not before.
 */
import type { ModelCandidate, ModelRankingResult, ModelTaskDomain, ModelTaskType, RouterStatus } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BorderedSelectPanel, type MnemonicContext, type TabBarTheme, TabbedContainer, type TextMeasure } from "malevich-tui-components";
import {
	type CacheEconomicsPanelAction,
	type CacheEconomicsPanelClient,
	createCacheEconomicsPanel,
	fetchCacheEconomicsSummary,
	showCacheEconomicsPanel,
} from "./observability/cache-economics-view.ts";
import {
	createStatusPanel,
	fetchStatusSnapshot,
	type JittorPanelClient,
	type PanelAction,
	runStatusAction,
	type StatusPanelSnapshot,
	showJittorPanel,
} from "./observability/status.ts";
import {
	type BenchmarkPanelAction,
	type BenchmarkPanelClient,
	createBenchmarkPanel,
	fetchBenchmarkRanking,
	showBenchmarkPanel,
} from "./optimization/model-selection-panel.ts";
import type { CodexRecoveryControl, EnforcementControl, UsageBudgetControl } from "./settings.ts";
import {
	createSettingsPanel,
	runSettingsAction,
	type SettingsAction,
	type SettingsEffects,
	type SettingsSnapshot,
	settingsSnapshot,
	showSettingsPanel,
} from "./settings-tui.ts";

export type JittorTabKey = "settings" | "status" | "benchmarks" | "cache";

export interface JittorShellDeps {
	settings: {
		enforcement: EnforcementControl;
		recovery: CodexRecoveryControl;
		budgets: UsageBudgetControl;
		effects: SettingsEffects;
	};
	status: { client: JittorPanelClient };
	benchmarks: {
		client: BenchmarkPanelClient;
		candidates: ModelCandidate[];
		currentIdentity: string;
		domain: ModelTaskDomain;
		type: ModelTaskType;
	};
	cache: { client: CacheEconomicsPanelClient; windowMs: number; now?: () => number };
}

interface ShellTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

/**
 * A real tree describing every key genuinely reachable at once inside the shell -- the shell's
 * own tab-cycling/close bindings at the root, plus each tab's own bindings as a sibling leaf
 * (siblings are never simultaneously active, so two tabs may freely reuse the same letter for
 * different things; only a leaf's own root-to-tab path is checked). Kept in sync by hand with
 * what createStatusPanel/createBenchmarkPanel/createCacheEconomicsPanel/createSettingsPanel and
 * this module's own outer handleInput actually wire -- run through assertNoMnemonicConflicts as a
 * standing test so a newly added keybinding that collides fails loudly, not just live.
 */
export function jittorShellMnemonicTree(): MnemonicContext {
	return {
		name: "jittor-shell",
		bindings: [
			{ key: "escape", description: "close shell" },
			{ key: "ctrl+c", description: "close shell" },
			{ key: "tab", description: "next tab" },
			{ key: "shift+tab", description: "previous tab" },
			{ key: "left", description: "previous tab" },
			{ key: "right", description: "next tab" },
		],
		children: [
			{
				name: "settings",
				bindings: [
					{ key: "up", description: "menu up" },
					{ key: "down", description: "menu down" },
					{ key: "enter", description: "menu activate" },
					{ key: "space", description: "menu activate" },
					{ key: "escape", description: "close shell" },
				],
			},
			{
				name: "status",
				bindings: [
					{ key: "r", description: "refresh status" },
					{ key: "p", description: "pause/resume" },
					{ key: "o", description: "override route" },
					{ key: "c", description: "clear override" },
					{ key: "escape", description: "close shell" },
				],
			},
			{
				name: "benchmarks",
				bindings: [
					{ key: "r", description: "refresh benchmarks" },
					{ key: "escape", description: "close shell" },
				],
			},
			{
				name: "cache",
				bindings: [
					{ key: "r", description: "refresh cache" },
					{ key: "escape", description: "close shell" },
				],
			},
		],
	};
}

interface ShellState {
	settings?: SettingsSnapshot;
	status?: StatusPanelSnapshot;
	benchmarks?: ModelRankingResult;
	cache?: Awaited<ReturnType<typeof fetchCacheEconomicsSummary>>;
}

async function ensureLoaded(
	activeKey: JittorTabKey,
	state: ShellState,
	deps: JittorShellDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	// Settings reads already-in-memory persisted state -- no daemon round trip, so eagerly keeping
	// it fresh costs nothing and never violates "no network call for a tab never visited".
	state.settings = settingsSnapshot(deps.settings.enforcement, deps.settings.recovery, deps.settings.budgets);
	if (activeKey === "status" && state.status === undefined) {
		state.status = await fetchStatusSnapshot(deps.status.client, ctx.sessionManager.getSessionId());
	}
	if (activeKey === "benchmarks" && state.benchmarks === undefined) {
		state.benchmarks = await fetchBenchmarkRanking(
			ctx,
			deps.benchmarks.client,
			deps.benchmarks.candidates,
			deps.benchmarks.domain,
			deps.benchmarks.type,
		);
	}
	if (activeKey === "cache" && state.cache === undefined) {
		state.cache = await fetchCacheEconomicsSummary(deps.cache.client, deps.cache.windowMs, deps.cache.now);
	}
}

function loadingContent(label: string) {
	return {
		invalidate: () => {},
		render: (width: number): string[] => [truncateToWidth(`Loading ${label}\u2026`, width, "\u2026")],
	};
}

type ShellOutcome =
	| { kind: "close" }
	| { kind: "tab-changed" }
	| { kind: "settings"; action: SettingsAction }
	| { kind: "status"; action: PanelAction }
	| { kind: "benchmarks"; action: BenchmarkPanelAction }
	| { kind: "cache"; action: CacheEconomicsPanelAction };

function tabBarTheme(theme: ShellTheme): TabBarTheme {
	return {
		tab: (text) => theme.fg("dim", text),
		activeTab: (text) => theme.bold(theme.fg("accent", text)),
		mnemonic: (text) => theme.bold(text),
	};
}

/**
 * Falls back to each subcommand's own already-tested non-TUI notify (outside TUI mode, there is
 * no tab bar to consolidate -- one plain-text notify per subcommand is unchanged and correct).
 */
async function showNonTuiFallback(ctx: ExtensionCommandContext, deps: JittorShellDeps, initialTab: JittorTabKey): Promise<void> {
	if (initialTab === "settings")
		return showSettingsPanel(ctx, deps.settings.enforcement, deps.settings.recovery, deps.settings.budgets, deps.settings.effects);
	if (initialTab === "status") return showJittorPanel(ctx, deps.status.client);
	if (initialTab === "benchmarks")
		return showBenchmarkPanel(
			ctx,
			deps.benchmarks.client,
			deps.benchmarks.candidates,
			deps.benchmarks.currentIdentity,
			deps.benchmarks.domain,
			deps.benchmarks.type,
		);
	return showCacheEconomicsPanel(ctx, deps.cache.client, deps.cache.windowMs, deps.cache.now);
}

export async function showJittorShell(
	ctx: ExtensionCommandContext,
	deps: JittorShellDeps,
	initialTab: JittorTabKey = "settings",
): Promise<void> {
	if (ctx.mode !== "tui") return showNonTuiFallback(ctx, deps, initialTab);

	let activeKey: JittorTabKey = initialTab;
	const state: ShellState = {};

	for (;;) {
		await ensureLoaded(activeKey, state, deps, ctx);
		const outcome = await ctx.ui.custom<ShellOutcome>((tui, theme, _keybindings, done) => {
			const tabs = [
				{
					key: "settings" as const,
					label: "Settings",
					content: createSettingsPanel(state.settings!, theme, (action) => done({ kind: "settings", action }), 0, false),
				},
				{
					key: "status" as const,
					label: "Status",
					mnemonic: "u",
					content:
						state.status === undefined
							? loadingContent("Status")
							: createStatusPanel(state.status, theme, (action) => done({ kind: "status", action }), false),
				},
				{
					key: "benchmarks" as const,
					label: "Benchmarks",
					content:
						state.benchmarks === undefined
							? loadingContent("Benchmarks")
							: createBenchmarkPanel(
									state.benchmarks,
									deps.benchmarks.currentIdentity,
									theme,
									(action) => done({ kind: "benchmarks", action }),
									false,
								),
				},
				{
					key: "cache" as const,
					label: "Cache",
					content:
						state.cache === undefined
							? loadingContent("Cache")
							: createCacheEconomicsPanel(state.cache, theme, (action) => done({ kind: "cache", action }), false),
				},
			];
			const container = new TabbedContainer({
				tabs,
				theme: tabBarTheme(theme),
				initialKey: activeKey,
				onChange: (key) => {
					activeKey = key as JittorTabKey;
					done({ kind: "tab-changed" });
				},
			});
			const outer = new BorderedSelectPanel({
				title: "Jittor",
				list: container,
				helpText: "Tab/Shift+Tab switch tabs \u00b7 Esc close",
				theme: {
					border: (text) => theme.fg("borderMuted", text),
					title: theme.bold,
					help: (text) => theme.fg("dim", text),
				},
				measure: hostTextMeasure,
			});
			return {
				invalidate: () => outer.invalidate(),
				render: (width: number) => outer.render(width),
				handleInput(data: string): void {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done({ kind: "close" });
						return;
					}
					outer.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!outcome || outcome.kind === "close") return;
		if (outcome.kind === "tab-changed") continue;
		if (outcome.kind === "settings") {
			await runSettingsAction(
				ctx,
				outcome.action,
				deps.settings.enforcement,
				deps.settings.recovery,
				deps.settings.budgets,
				deps.settings.effects,
			);
			continue;
		}
		if (outcome.kind === "status") {
			await runStatusAction(
				ctx,
				deps.status.client,
				outcome.action,
				state.status as StatusPanelSnapshot,
				ctx.sessionManager.getSessionId(),
			);
			state.status = undefined;
			continue;
		}
		if (outcome.kind === "benchmarks") {
			if (outcome.action === "refresh") await deps.benchmarks.client.call("benchmark.refresh", { force: true });
			state.benchmarks = undefined;
			continue;
		}
		// "cache": refresh has no separate daemon mutation -- looping back to refetch is the whole effect.
		state.cache = undefined;
	}
}
