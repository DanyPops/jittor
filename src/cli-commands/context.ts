import type { ContextAssessment } from "../domain/context-telemetry.ts";
import type { CliDependencies } from "./support.ts";

export const CONTEXT_USAGE_LINES = ["  context [--since <ms>] [--until <ms>] [--json]"];

function parseContextArgs(args: string[]): { input: { since?: number; until?: number }; json: boolean } | null {
	const input: { since?: number; until?: number } = {};
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (argument !== "--since" && argument !== "--until") return null;
		const raw = args[++index];
		const value = raw === undefined ? Number.NaN : Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) return null;
		if (argument === "--since") input.since = value;
		else input.until = value;
	}
	if (input.since !== undefined && input.until !== undefined && input.until < input.since) return null;
	return { input, json };
}

function value(value: number | null, suffix = ""): string {
	return value === null ? "unknown" : `${Math.round(value).toLocaleString()}${suffix}`;
}

export function formatContextAssessment(summary: ContextAssessment): string {
	return [
		`Context assessment: ${summary.completeness}`,
		`Papyrus injection: ${summary.injection.runs} runs · avg ${value(summary.injection.averageCharacters, " chars")} · p95 ${value(summary.injection.p95Characters, " chars")} · max ${value(summary.injection.maxCharacters, " chars")}`,
		`Injection mix: rules ${summary.injection.ruleCharacters.toLocaleString()} chars · tasks ${summary.injection.taskCharacters.toLocaleString()} chars · estimated ${summary.injection.estimatedTokens.toLocaleString()} tokens · unchanged ${summary.injection.unchangedRate === null ? "unknown" : `${(summary.injection.unchangedRate * 100).toFixed(1)}%`}`,
		`Compactions: ${summary.compaction.completed} completed · ${summary.compaction.aborted} aborted · avg ${value(summary.compaction.averageDurationMs, "ms")} · ${summary.compaction.perRun === null ? "unknown" : summary.compaction.perRun.toFixed(3)} per agent run · ${summary.compaction.perTurn === null ? "unknown" : summary.compaction.perTurn.toFixed(3)} per turn`,
		`Between compactions: ${value(summary.compaction.averageTurnsBetween, " turns")} · ${value(summary.compaction.averageProviderTokensBetween, " provider tokens")} · ${value(summary.compaction.averageCacheReadTokensBetween, " cache-read tokens")}`,
		`Reasons: threshold ${summary.compaction.reasons.threshold} · overflow ${summary.compaction.reasons.overflow} · manual ${summary.compaction.reasons.manual}`,
	].join("\n");
}

export async function runContextCommand(action: string | undefined, rest: string[], deps: CliDependencies, usage: () => number): Promise<number> {
	const parsed = parseContextArgs([...(action === undefined ? [] : [action]), ...rest]);
	if (!parsed) return usage();
	try {
		const summary = await deps.client.call("context.assess", parsed.input);
		deps.stdout(parsed.json ? JSON.stringify(summary) : formatContextAssessment(summary));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
