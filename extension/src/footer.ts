import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface FooterTheme {
	fg(color: "dim" | "warning" | "error", text: string): string;
	bold(text: string): string;
}

interface FooterData {
	getGitBranch(): string | null | undefined;
	getAvailableProviderCount(): number;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

interface FooterContext {
	model?: { provider: string; id: string; reasoning?: boolean; contextWindow?: number };
	modelRegistry: { isUsingOAuth(model: unknown): boolean };
	getContextUsage(): { percent: number | null; contextWindow: number } | undefined;
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
		getEntries(): Array<{ type: string; message?: any }>;
	};
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

function usageTotals(context: FooterContext): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; cacheHit?: number } {
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

export function renderFooterLines(
	context: FooterContext,
	footerData: FooterData,
	theme: FooterTheme,
	providerUsage: string,
	thinkingLevel: string,
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	let cwd = footerCwd(context.sessionManager.getCwd(), process.env.HOME ?? process.env.USERPROFILE);
	const branch = footerData.getGitBranch();
	if (branch) cwd += ` (${branch})`;
	const sessionName = context.sessionManager.getSessionName();
	if (sessionName) cwd += ` • ${sessionName}`;

	const totals = usageTotals(context);
	const leftParts: string[] = [];
	if (totals.input) leftParts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) leftParts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) leftParts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) leftParts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead || totals.cacheWrite) && totals.cacheHit !== undefined) leftParts.push(`CH${totals.cacheHit.toFixed(1)}%`);
	if (totals.cost || (context.model && context.modelRegistry.isUsingOAuth(context.model))) {
		leftParts.push(`$${totals.cost.toFixed(3)}${context.model && context.modelRegistry.isUsingOAuth(context.model) ? " (sub)" : ""}`);
	}
	const contextUsage = context.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? context.model?.contextWindow ?? 0;
	const contextText = contextUsage?.percent === null || contextUsage === undefined
		? `?/${formatTokens(contextWindow)} (auto)`
		: `${contextUsage.percent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
	leftParts.push(contextText);
	let left = leftParts.join(" ");

	const model = context.model;
	const modelName = model?.id ?? "no-model";
	const modelThinking = model?.reasoning ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}` : modelName;
	const providerModel = model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ${modelThinking}` : modelThinking;
	const candidates = [
		providerUsage ? `${providerModel} • ${providerUsage}` : providerModel,
		providerModel,
		modelThinking,
		modelName,
	];
	let right = candidates.find((candidate) => visibleWidth(candidate) <= Math.max(1, safeWidth - 2)) ?? truncateToWidth(modelName, safeWidth, "");
	const availableLeft = Math.max(0, safeWidth - visibleWidth(right) - 1);
	left = truncateToWidth(left, availableLeft, availableLeft >= 3 ? "…" : "");
	const padding = " ".repeat(Math.max(1, safeWidth - visibleWidth(left) - visibleWidth(right)));
	const statsLine = truncateToWidth(`${left}${padding}${right}`, safeWidth, "");

	const lines = [
		truncateToWidth(theme.fg("dim", cwd), safeWidth, theme.fg("dim", "…")),
		theme.fg("dim", statsLine),
	];
	const statuses = [...footerData.getExtensionStatuses().entries()]
		.filter(([key]) => key !== "jittor")
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([, text]) => sanitize(text));
	if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), safeWidth, theme.fg("dim", "…")));
	return lines;
}

export interface IntegratedFooterState {
	providerUsage: string;
	requestRender?: () => void;
}

export function installIntegratedFooter(ctx: ExtensionContext, state: IntegratedFooterState, getThinkingLevel: () => string): void {
	ctx.ui.setStatus("jittor", undefined);
	ctx.ui.setFooter((tui, theme, footerData) => {
		state.requestRender = () => tui.requestRender();
		return {
		invalidate() {},
		render(width: number): string[] {
			return renderFooterLines(ctx as unknown as FooterContext, footerData, theme, state.providerUsage, getThinkingLevel(), width);
		},
		dispose() {
			state.requestRender = undefined;
			tui.requestRender();
		},
	};
	});
}
