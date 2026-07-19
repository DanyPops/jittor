import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	FOOTER_BAR_MAX_WIDTH,
	FOOTER_BAR_MIN_WIDTH,
	FOOTER_CONTEXT_ACCENT_FRACTION,
	FOOTER_CONTEXT_ERROR_FRACTION,
	FOOTER_CONTEXT_WARNING_FRACTION,
	FOOTER_WIDE_TERMINAL_WIDTH,
	TELEMETRY_STALE_AFTER_MS,
} from "../../src/constants.ts";

type FooterColor = "accent" | "dim" | "warning" | "error";

interface FooterTheme {
	fg(color: FooterColor, text: string): string;
	bold(text: string): string;
}

interface FooterData {
	getGitBranch(): string | null | undefined;
	getAvailableProviderCount(): number;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange?(callback: () => void): () => void;
}

interface ContextUsage {
	tokens: number | null;
	percent: number | null;
	contextWindow: number;
}

interface FooterContext {
	model?: { provider: string; id: string; reasoning?: boolean; contextWindow?: number };
	modelRegistry: { isUsingOAuth(model: unknown): boolean };
	getContextUsage(): ContextUsage | undefined;
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
		getEntries(): Array<{ type: string; message?: any }>;
	};
}

/** A provider usage value suitable for the footer. Null fraction means no known denominator. */
export interface ProviderBudget {
	label: string;
	fraction: number | null;
	valueText: string;
	observedAt?: number;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHit?: number;
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function footerCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const inside = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!inside) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitize(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function usageTotals(context: FooterContext): UsageTotals {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, cacheHit: number | undefined;
	for (const entry of context.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage;
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
		cacheRead += usage?.cacheRead ?? 0;
		cacheWrite += usage?.cacheWrite ?? 0;
		cost += usage?.cost?.total ?? 0;
		const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		if (prompt > 0) cacheHit = (usage.cacheRead ?? 0) / prompt * 100;
	}
	return { input, output, cacheRead, cacheWrite, cost, ...(cacheHit === undefined ? {} : { cacheHit }) };
}

function barWidth(width: number): number {
	return width >= FOOTER_WIDE_TERMINAL_WIDTH ? FOOTER_BAR_MAX_WIDTH : FOOTER_BAR_MIN_WIDTH;
}

function progressBar(fraction: number | null, width: number): string {
	if (fraction === null || !Number.isFinite(fraction)) return "░".repeat(width);
	const clamped = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(width * clamped);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function fillColor(fraction: number | null): FooterColor {
	if (fraction === null || !Number.isFinite(fraction)) return "dim";
	if (fraction > FOOTER_CONTEXT_ERROR_FRACTION) return "error";
	if (fraction > FOOTER_CONTEXT_WARNING_FRACTION) return "warning";
	if (fraction > FOOTER_CONTEXT_ACCENT_FRACTION) return "accent";
	return "dim";
}

function contextSegment(context: FooterContext, theme: FooterTheme, width: number, compact: boolean): string {
	const usage = context.getContextUsage();
	const window = usage?.contextWindow ?? context.model?.contextWindow ?? 0;
	const fraction = usage?.percent === null || usage?.percent === undefined ? null : usage.percent / 100;
	const bar = theme.fg(fillColor(fraction), progressBar(fraction, barWidth(width)));
	if (usage?.tokens === null || usage?.tokens === undefined) return `ctx ${bar} ?/${formatTokens(window)}`;
	const value = compact ? `${Math.round((fraction ?? 0) * 100)}%` : `${formatTokens(usage.tokens)}/${formatTokens(window)}`;
	return `ctx ${bar} ${value}`;
}

function budgetSegment(budget: ProviderBudget | null, theme: FooterTheme, width: number, compact: boolean, now: number): string {
	const w = barWidth(width);
	if (!budget) return `budget ${theme.fg("dim", progressBar(null, w))} ?`;
	if (budget.fraction === null) return `${budget.label} ${budget.valueText}`;
	const bar = theme.fg(fillColor(budget.fraction), progressBar(budget.fraction, w));
	const value = compact ? `${Math.round(budget.fraction * 100)}%` : budget.valueText;
	const stale = budget.observedAt !== undefined && now - budget.observedAt > TELEMETRY_STALE_AFTER_MS;
	return `${budget.label} ${bar} ${value}${stale ? ` ${theme.fg("warning", "stale")}` : ""}`;
}

function usageSegment(context: FooterContext): string {
	const totals = usageTotals(context);
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead || totals.cacheWrite) && totals.cacheHit !== undefined) parts.push(`CH${totals.cacheHit.toFixed(1)}%`);
	if (totals.cost || (context.model && context.modelRegistry.isUsingOAuth(context.model))) {
		parts.push(`$${totals.cost.toFixed(3)}${context.model && context.modelRegistry.isUsingOAuth(context.model) ? " (sub)" : ""}`);
	}
	return parts.join(" ");
}

function identityLines(context: FooterContext, footerData: FooterData, theme: FooterTheme, thinkingLevel: string, width: number): string[] {
	let cwd = footerCwd(context.sessionManager.getCwd(), process.env.HOME ?? process.env.USERPROFILE);
	const branch = footerData.getGitBranch();
	if (branch) cwd += ` (${branch})`;
	const sessionName = context.sessionManager.getSessionName();
	if (sessionName) cwd += ` · ${sessionName}`;
	const repo = `${theme.bold("Repo")} ${theme.fg("dim", cwd)}`;

	const model = context.model;
	const provider = model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ` : "";
	const thinking = model?.reasoning ? ` · ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}` : "";
	const ai = `${theme.bold("AI")} ${provider}${model?.id ?? "no-model"}${thinking}`;
	const gap = width - visibleWidth(repo) - visibleWidth(ai);
	if (gap >= 2) return [`${repo}${" ".repeat(gap)}${ai}`];
	return [truncateToWidth(repo, width, "…"), truncateToWidth(ai, width, "…")];
}

function statusLines(context: FooterContext, budget: ProviderBudget | null, theme: FooterTheme, width: number, now: number): string[] {
	const usage = usageSegment(context);
	const fullContext = contextSegment(context, theme, width, false);
	const fullBudget = budgetSegment(budget, theme, width, false, now);
	const fullParts = [usage, fullContext, fullBudget].filter(Boolean);
	const full = `${theme.bold("LLM")} ${fullParts.join(" · ")}`;
	if (visibleWidth(full) <= width) return [full];

	const compactContext = contextSegment(context, theme, width, true);
	const compactBudget = budgetSegment(budget, theme, width, true, now);
	const compact = `${theme.bold("LLM")} ${compactContext} · ${compactBudget}`;
	if (visibleWidth(compact) <= width) return [compact];
	return [
		truncateToWidth(`${theme.bold("LLM")} ${compactContext}`, width, ""),
		truncateToWidth(`${theme.bold("LLM")} ${compactBudget}`, width, ""),
	];
}

export function renderFooterLines(
	context: FooterContext,
	footerData: FooterData,
	theme: FooterTheme,
	providerBudget: ProviderBudget | null,
	thinkingLevel: string,
	width: number,
	now = Date.now(),
): string[] {
	const safeWidth = Math.max(1, width);
	const lines = [
		...identityLines(context, footerData, theme, thinkingLevel, safeWidth),
		...statusLines(context, providerBudget, theme, safeWidth, now),
	];
	const statuses = [...footerData.getExtensionStatuses().entries()]
		.filter(([key]) => key !== "jittor")
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([, text]) => sanitize(text));
	if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), safeWidth, theme.fg("dim", "…")));
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

export interface IntegratedFooterState {
	providerBudget: ProviderBudget | null;
	requestRender?: () => void;
}

export function installIntegratedFooter(ctx: ExtensionContext, state: IntegratedFooterState, getThinkingLevel: () => string): void {
	ctx.ui.setStatus("jittor", undefined);
	ctx.ui.setFooter((tui, theme, footerData) => {
		state.requestRender = () => tui.requestRender();
		const unsubscribe = (footerData as FooterData).onBranchChange?.(() => tui.requestRender());
		return {
			invalidate() {},
			render(width: number): string[] {
				return renderFooterLines(ctx as unknown as FooterContext, footerData, theme, state.providerBudget, getThinkingLevel(), width);
			},
			dispose() {
				unsubscribe?.();
				state.requestRender = undefined;
				tui.requestRender();
			},
		};
	});
}
