import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	FOOTER_BAR_MAX_WIDTH,
	FOOTER_BAR_MIN_WIDTH,
	FOOTER_CONTEXT_ACCENT_FRACTION,
	FOOTER_CONTEXT_ERROR_FRACTION,
	FOOTER_COMPACTION_BLINK_HALF_PERIOD_MS,
	FOOTER_CONTEXT_WARNING_FRACTION,
	FOOTER_WIDE_TERMINAL_WIDTH,
	MILLISECONDS_PER_DAY,
	MILLISECONDS_PER_HOUR,
	MILLISECONDS_PER_MINUTE,
	MILLISECONDS_PER_SECOND,
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

/** A bounded quota is explicitly remaining; unbounded values never receive a fabricated bar. */
export type ProviderBudget = {
	kind: "bounded";
	label: string;
	remainingFraction: number;
	observedAt?: number;
	resetsAt?: number;
	resetText?: string;
} | {
	kind: "unbounded";
	label: string;
	valueText: string;
	observedAt?: number;
};

export interface CompactionProgress {
	startedAt: number;
	initialFraction: number;
	/** Learned median duration from jittor-cli's `compaction.estimate`; absent/null means cold-start. */
	estimatedMs?: number | null;
	confidence?: "cold-start" | "learned";
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

/**
 * Once a learned median duration is available (see estimateCompactionDuration / the
 * `compaction.estimate` daemon operation), the bar drains against that real estimate: fraction
 * counts down linearly from 1 to 0 over estimatedMs, exactly in step with the countdown shown in
 * compactionStatusText — same elapsed/estimatedMs ratio drives both. Until then — cold start, or
 * the estimate fetch has not resolved yet — there is no real duration to drain against, so the
 * fill holds steady at the fraction observed when compaction started; the blink alone (see
 * compactionBarGlyph) communicates liveness without fabricating a rate.
 */
function compactionFraction(progress: CompactionProgress, width: number, now: number): number {
	if (progress.confidence === "learned" && typeof progress.estimatedMs === "number" && progress.estimatedMs > 0) {
		const elapsed = Math.max(0, now - progress.startedAt);
		return Math.max(0, Math.min(1, 1 - (elapsed / progress.estimatedMs)));
	}
	return Math.min(1, Math.max(0, progress.initialFraction));
}

/**
 * Liveness blink independent of whether the drain bar reflects a learned estimate or the
 * fixed-rate cold-start fallback: it does not claim to know how long compaction will take, only
 * that it has not stalled. It toggles once per render tick so a single owned interval (installed
 * in beginCompactionUi) drives both the drain and the blink — no extra timer is created here.
 */
export function compactionBlinkOn(startedAt: number, now: number, halfPeriodMs = FOOTER_COMPACTION_BLINK_HALF_PERIOD_MS): boolean {
	const elapsed = Math.max(0, now - startedAt);
	return Math.floor(elapsed / halfPeriodMs) % 2 === 0;
}

/**
 * The compaction signal lives in the bar itself: it blinks between its normal draining fill and a
 * blank track of the same width, rather than a separate indicator glyph next to it. Off-phase
 * intentionally renders identically to the "no data" empty track (dim, all "░") so the bar reads
 * as a single blinking element, not a bar plus a decoration.
 */
function compactionBarGlyph(progress: CompactionProgress, theme: FooterTheme, width: number, now: number): string {
	if (!compactionBlinkOn(progress.startedAt, now)) return theme.fg("dim", "░".repeat(width));
	const fraction = compactionFraction(progress, width, now);
	return theme.fg("accent", progressBar(fraction, width));
}

/**
 * A countdown, never a count-up: once a learned estimate exists it reports seconds remaining,
 * ticking down toward zero in step with the draining bar. Before that (cold start, no estimate
 * yet) there is nothing true to count down from, so this reports nothing at all rather than a
 * fabricated elapsed count or a guessed total — the blinking, non-draining bar is the only signal.
 */
function compactionStatusText(progress: CompactionProgress, now: number): string | undefined {
	if (progress.confidence === "learned" && typeof progress.estimatedMs === "number" && progress.estimatedMs > 0) {
		const remainingSeconds = Math.max(0, Math.ceil((progress.estimatedMs - (now - progress.startedAt)) / MILLISECONDS_PER_SECOND));
		return `compact ~${remainingSeconds}s left`;
	}
	return undefined;
}

function contextSegment(
	context: FooterContext,
	theme: FooterTheme,
	width: number,
	compact: boolean,
	now: number,
	compaction?: CompactionProgress,
): string {
	const w = barWidth(width);
	if (compaction) {
		const bar = compactionBarGlyph(compaction, theme, w, now);
		const statusText = compactionStatusText(compaction, now);
		return statusText === undefined ? `ctx ${bar}` : `ctx ${bar} ${statusText}`;
	}
	const usage = context.getContextUsage();
	const window = usage?.contextWindow ?? context.model?.contextWindow ?? 0;
	const fraction = usage?.percent === null || usage?.percent === undefined ? null : usage.percent / 100;
	const bar = theme.fg(fillColor(fraction), progressBar(fraction, w));
	if (usage?.tokens === null || usage?.tokens === undefined) return `ctx ${bar} ?/${formatTokens(window)}`;
	const value = compact ? `${Math.round((fraction ?? 0) * 100)}%` : `${formatTokens(usage.tokens)}/${formatTokens(window)}`;
	return `ctx ${bar} ${value}`;
}

function minimalContextSegment(
	context: FooterContext,
	theme: FooterTheme,
	width: number,
	now: number,
	compaction?: CompactionProgress,
): string {
	const w = barWidth(width);
	if (compaction) {
		return `ctx ${compactionBarGlyph(compaction, theme, w, now)}`;
	}
	const percent = context.getContextUsage()?.percent;
	const fraction = percent === null || percent === undefined ? null : percent / 100;
	return `ctx ${theme.fg(fillColor(fraction), progressBar(fraction, w))}`;
}

function resetLabel(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined) return undefined;
	const remaining = resetsAt - now;
	if (remaining <= 0) return "reset due";
	if (remaining >= MILLISECONDS_PER_DAY) return `resets in ${Math.floor(remaining / MILLISECONDS_PER_DAY)}d`;
	if (remaining >= MILLISECONDS_PER_HOUR) return `resets in ${Math.floor(remaining / MILLISECONDS_PER_HOUR)}h`;
	return `resets in ${Math.max(1, Math.ceil(remaining / MILLISECONDS_PER_MINUTE))}m`;
}

function budgetSegment(budget: ProviderBudget | null, theme: FooterTheme, width: number, compact: boolean, now: number): string {
	const w = barWidth(width);
	if (!budget) return `budget ${theme.fg("dim", progressBar(null, w))} ?`;
	const stale = budget.observedAt !== undefined && now - budget.observedAt > TELEMETRY_STALE_AFTER_MS;
	const staleText = stale ? ` ${theme.fg("warning", "stale")}` : "";
	if (budget.kind === "unbounded") return `${budget.label} ${budget.valueText}${staleText}`;
	const remaining = Math.min(1, Math.max(0, budget.remainingFraction));
	const bar = theme.fg(fillColor(1 - remaining), progressBar(remaining, w));
	const value = `${(compact ? Math.round(remaining * 100) : (remaining * 100).toFixed(1))}% left`;
	const reset = compact ? undefined : resetLabel(budget.resetsAt, now) ?? budget.resetText;
	return `${budget.label} ${bar} ${value}${reset ? ` · ${reset}` : ""}${staleText}`;
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

function repositorySegment(context: FooterContext, footerData: FooterData, theme: FooterTheme): string {
	let cwd = footerCwd(context.sessionManager.getCwd(), process.env.HOME ?? process.env.USERPROFILE);
	const branch = footerData.getGitBranch();
	if (branch) cwd += ` (${branch})`;
	const sessionName = context.sessionManager.getSessionName();
	if (sessionName) cwd += ` · ${sessionName}`;
	return theme.fg("dim", cwd);
}

function modelSegments(context: FooterContext, footerData: FooterData, theme: FooterTheme, thinkingLevel: string): { full: string; compact: string } {
	const model = context.model;
	const modelName = theme.bold(model?.id ?? "no-model");
	const provider = model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ` : "";
	const thinking = model?.reasoning ? ` · ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}` : "";
	return { full: `${provider}${modelName}${thinking}`, compact: modelName };
}

function compactUsageSegment(context: FooterContext): string {
	const totals = usageTotals(context);
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	return parts.join(" ");
}

function joinSegments(segments: Array<string | undefined>): string {
	return segments.filter((segment): segment is string => Boolean(segment)).join(" · ");
}

export function renderFooterLines(
	context: FooterContext,
	footerData: FooterData,
	theme: FooterTheme,
	providerBudget: ProviderBudget | null,
	thinkingLevel: string,
	width: number,
	now = Date.now(),
	compaction?: CompactionProgress,
): string[] {
	const safeWidth = Math.max(1, width);
	const repository = repositorySegment(context, footerData, theme);
	const model = modelSegments(context, footerData, theme, thinkingLevel);
	const usage = usageSegment(context);
	const compactUsage = compactUsageSegment(context);
	const fullContext = contextSegment(context, theme, safeWidth, false, now, compaction);
	const compactContext = contextSegment(context, theme, safeWidth, true, now, compaction);
	const minimalContext = minimalContextSegment(context, theme, safeWidth, now, compaction);
	const fullBudget = budgetSegment(providerBudget, theme, safeWidth, false, now);
	const compactBudget = budgetSegment(providerBudget, theme, safeWidth, true, now);
	const statuses = [...footerData.getExtensionStatuses().entries()]
		.filter(([key]) => key !== "jittor")
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([, text]) => sanitize(text))
		.join(" ");

	const candidates = [
		joinSegments([repository, model.full, usage, fullContext, fullBudget, statuses]),
		joinSegments([repository, model.full, usage, fullContext, fullBudget]),
		joinSegments([model.full, usage, compactContext, compactBudget, statuses]),
		joinSegments([model.full, usage, compactContext, compactBudget]),
		joinSegments([model.full, compactUsage, compactContext, compactBudget]),
		joinSegments([model.compact, compactUsage, compactContext, compactBudget]),
		joinSegments([model.compact, compactContext, compactBudget]),
		joinSegments([model.compact, minimalContext, compactBudget]),
	];
	const line = candidates.find((candidate) => visibleWidth(candidate) <= safeWidth) ?? candidates.at(-1) ?? "";
	return [truncateToWidth(line, safeWidth, "")];
}

export interface IntegratedFooterState {
	providerBudget: ProviderBudget | null;
	compaction?: CompactionProgress;
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
				return renderFooterLines(ctx as unknown as FooterContext, footerData, theme, state.providerBudget, getThinkingLevel(), width, Date.now(), state.compaction);
			},
			dispose() {
				unsubscribe?.();
				state.requestRender = undefined;
				tui.requestRender();
			},
		};
	});
}
