/**
 * Confirm/select prompts rendered with malevich-tui-components' own Dialog/TabMenu, inside
 * jittor's own theme and frame -- replacing Pi's host-native `ctx.ui.confirm`/`ctx.ui.select`
 * (a visually separate native prompt) for every jittor-owned confirmation and selection.
 *
 * TUI-only: every real caller (settings-tui.ts's runSettingsAction, observability/status.ts's
 * runStatusAction/chooseOverride) is itself only ever invoked from within an already-`ctx.mode
 * === "tui"` code path -- the non-TUI notify fallback returns before ever reaching one of these
 * calls -- so there is no non-TUI branch to fall back to here.
 *
 * Budget entry (settings-tui.ts's editBudget) deliberately keeps Pi's native `ctx.ui.input`:
 * malevich has no plain visible text-input component today -- only `MaskedInput` (renders mask
 * glyphs only, built for secrets; wrong semantics for a token count a user wants to see as they
 * type) and `Form` (owns focus/validation/layout but requires a host-supplied `FormFieldInput`,
 * and `MaskedInput` is the only one malevich ships). Building a new visible-text-input component
 * is out of scope here; this is a deliberate, documented decision, not an oversight.
 */
import type { Route } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Dialog, TabMenu, type TextMeasure } from "malevich-tui-components";

interface PromptTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const hostTextMeasure: TextMeasure = { visibleWidth, truncateToWidth };

/**
 * A bordered Dialog with exactly a Yes/No choice, resolving `true` for confirm, `false` for
 * cancel -- including Escape, Ctrl+C, or the host dismissing the panel outright (`custom()`
 * resolving `undefined`). A drop-in replacement for `ctx.ui.confirm(title, body)`.
 */
export async function showConfirmDialog(
	ctx: ExtensionCommandContext,
	title: string,
	body: string,
	options: { confirmLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
	const confirmLabel = options.confirmLabel ?? "Yes";
	const cancelLabel = options.cancelLabel ?? "No";
	const confirmed = await ctx.ui.custom<boolean>((_tui, theme: PromptTheme, _keybindings, done) => {
		const dialog = new Dialog({
			title,
			body,
			actions: [
				{ label: confirmLabel, key: "y", action: () => done(true) },
				{ label: cancelLabel, key: "n", action: () => done(false) },
			],
			theme: {
				border: (text) => theme.fg("borderMuted", text),
				title: theme.bold,
				body: (text) => text,
				dim: (text) => theme.fg("dim", text),
			},
			measure: hostTextMeasure,
		});
		return {
			invalidate: () => dialog.invalidate(),
			render: (width: number) => dialog.render(width),
			handleInput(data: string): void {
				if (matchesKey(data, "ctrl+c")) {
					done(false);
					return;
				}
				dialog.handleInput(data);
			},
		};
	});
	return confirmed ?? false;
}

/**
 * A TabMenu over one flat level -- every route is a leaf node, no drill-down -- resolving the
 * selected route, or `undefined` on cancel (Escape at the root, Ctrl+C, or the host dismissing
 * the panel outright). A drop-in replacement for `ctx.ui.select("Override route", labels)`
 * followed by mapping the chosen label back to its route.
 */
export async function showRouteOverrideMenu(
	ctx: ExtensionCommandContext,
	routes: Route[],
	routeLabel: (route: Route) => string,
): Promise<Route | undefined> {
	return ctx.ui.custom<Route | undefined>((_tui, theme: PromptTheme, _keybindings, done) => {
		const tabMenu = new TabMenu<Route>({
			nodes: routes.map((route) => ({ label: routeLabel(route), value: route })),
			theme: {
				tab: (text) => theme.fg("dim", text),
				activeTab: (text) => theme.bold(theme.fg("accent", text)),
				breadcrumb: (text) => theme.fg("dim", text),
				description: (text) => theme.fg("dim", text),
				help: (text) => theme.fg("dim", text),
			},
			onSelect: (route) => done(route),
			onCancel: () => done(undefined),
		});
		return {
			invalidate: () => tabMenu.invalidate(),
			render: (width: number) => tabMenu.render(width),
			handleInput(data: string): void {
				if (matchesKey(data, "ctrl+c")) {
					done(undefined);
					return;
				}
				tabMenu.handleInput(data);
			},
		};
	});
}
