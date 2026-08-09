import type { ContextDelta, ContextSnapshot } from "../observability/context-delta.ts";
import type { ContextAssessment } from "../observability/context-telemetry.ts";
import type { CliDependencies } from "./support.ts";

export const CONTEXT_USAGE_LINES = [
	"  context [--since <ms>] [--until <ms>] [--json]",
	"  context delta --session-id <opaque-id> [--json]",
	"  context snapshot --snapshot <json> [--json]",
];

function parseContextArgs(args: string[]): { input: { since?: number; until?: number }; json: boolean } | null {
	const input: { since?: number; until?: number } = {};
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
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

export function formatContextDelta(delta: ContextDelta | null): string {
	if (!delta) return "Context delta: unavailable (no snapshot recorded for this session)";
	const first = delta.firstChangedSegment;
	const lifecycle = new Map<string, number>();
	for (const change of delta.changes) lifecycle.set(change.lifecycle, (lifecycle.get(change.lifecycle) ?? 0) + 1);
	const lifecycleText = [...lifecycle.entries()].map(([name, count]) => `${name} ${count}`).join(" · ") || "none";
	const growth = delta.growthBySource
		.filter((item) => item.deltaTokens !== 0)
		.map((item) => `${item.source} ${item.deltaTokens > 0 ? "+" : ""}${item.deltaTokens.toLocaleString()} tokens`)
		.join(" · ");
	return [
		`Context delta: ${new Date(delta.capturedAt).toISOString()}`,
		`Stable prefix: ${delta.stablePrefixTokens.toLocaleString()} tokens${
			first ? ` · first change ${first.source} at request position ${first.requestPosition ?? "historical"}` : " · unchanged"
		}`,
		`Lifecycle: ${lifecycleText}`,
		`Growth: ${growth || "none"}`,
		"Stable-prefix correlation is structural evidence, not proof of provider cache behavior.",
	].join("\n");
}

function parseDeltaArgs(args: string[]): { input: { session_id: string }; json: boolean } | null {
	let sessionId: string | undefined;
	let json = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--json") json = true;
		else if (argument === "--session-id") sessionId = args[++index];
		else return null;
	}
	if (!sessionId || !/^[A-Za-z0-9_-]{32,64}$/.test(sessionId)) return null;
	return { input: { session_id: sessionId }, json };
}

function parseSnapshotArgs(args: string[]): { input: ContextSnapshot; json: boolean } | null {
	let snapshotValue: string | undefined;
	let json = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--json") json = true;
		else if (argument === "--snapshot") snapshotValue = args[++index];
		else return null;
	}
	if (!snapshotValue) return null;
	try {
		return { input: JSON.parse(snapshotValue) as ContextSnapshot, json };
	} catch {
		return null;
	}
}

export async function runContextCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	try {
		if (action === "delta") {
			const parsed = parseDeltaArgs(rest);
			if (!parsed) return usage();
			const delta = await deps.client.call("context.delta", parsed.input);
			deps.stdout(parsed.json ? JSON.stringify(delta) : formatContextDelta(delta));
			return 0;
		}
		if (action === "snapshot") {
			const parsed = parseSnapshotArgs(rest);
			if (!parsed) return usage();
			const delta = await deps.client.call("context.snapshot", parsed.input);
			deps.stdout(parsed.json ? JSON.stringify(delta) : formatContextDelta(delta));
			return 0;
		}
		const parsed = parseContextArgs([...(action === undefined ? [] : [action]), ...rest]);
		if (!parsed) return usage();
		const summary = await deps.client.call("context.assess", parsed.input);
		deps.stdout(parsed.json ? JSON.stringify(summary) : formatContextAssessment(summary));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
