import {
	BENCHMARK_MAX_QUERY_LIMIT,
	MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
	MODEL_RANKING_DEFAULT_COST_WEIGHT,
	MODEL_RANKING_DEFAULT_LATENCY_WEIGHT,
	MODEL_RANKING_DEFAULT_QUALITY_WEIGHT,
	MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
	MODEL_RANKING_MAX_SOURCES,
} from "../constants.ts";
import type { BenchmarkQuery, BenchmarkQueryResult, BenchmarkRefreshResult } from "../domain/benchmark.ts";
import { type ModelTaskDomain, type ModelTaskType, TASK_DOMAINS, TASK_TYPES } from "../domain/model-observation.ts";
import type { ModelCandidate, ModelRankingResult, ScopeAuthority, UtilityWeights } from "../domain/model-ranking.ts";
import type { ModelRecommendationInput } from "../domain/model-ranking-service.ts";
import { parseCandidate } from "./route-args.ts";
import { type CliDependencies, humanField } from "./support.ts";

export const BENCHMARKS_USAGE_LINES = ["  benchmarks <status|refresh|list|rank> [options] [--json]"];

interface BenchmarkArgs {
	action: "status" | "refresh" | "list" | "rank";
	json: boolean;
	force: boolean;
	query?: BenchmarkQuery;
	recommendation?: ModelRecommendationInput & { session_id?: string; session_secret?: string };
}

function parseBenchmarkArgs(action: string | undefined, args: string[]): BenchmarkArgs | null {
	if (action !== "status" && action !== "refresh" && action !== "list" && action !== "rank") return null;
	let json = false;
	let force = false;
	const query: Partial<BenchmarkQuery> = {};
	const candidates: ModelCandidate[] = [];
	const sourceIds: string[] = [];
	let scopeAuthority: ScopeAuthority = "available-models";
	let domain: ModelTaskDomain = "general";
	let type: ModelTaskType = "general";
	let budgetPressure = 0;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
	const weights: UtilityWeights = {
		quality: MODEL_RANKING_DEFAULT_QUALITY_WEIGHT,
		cost: MODEL_RANKING_DEFAULT_COST_WEIGHT,
		latency: MODEL_RANKING_DEFAULT_LATENCY_WEIGHT,
		context: MODEL_RANKING_DEFAULT_CONTEXT_WEIGHT,
		reliability: MODEL_RANKING_DEFAULT_RELIABILITY_WEIGHT,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--force" && action === "refresh") {
			force = true;
			continue;
		}
		const allowed =
			action === "list"
				? ["--source", "--model", "--dimension", "--limit"]
				: action === "rank"
					? [
							"--candidate",
							"--source",
							"--domain",
							"--type",
							"--scope",
							"--budget",
							"--weight-quality",
							"--weight-cost",
							"--weight-latency",
							"--weight-context",
							"--weight-reliability",
							"--session-id",
							"--session-secret",
						]
					: [];
		if (!allowed.includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (action === "list") {
			if (argument === "--limit") {
				const limit = Number(raw);
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > BENCHMARK_MAX_QUERY_LIMIT) return null;
				query.limit = limit;
			} else if (argument === "--source") query.sourceId = raw;
			else if (argument === "--model") query.model = raw;
			else query.dimension = raw;
			continue;
		}
		if (argument === "--candidate") {
			const candidate = parseCandidate(raw);
			if (!candidate) return null;
			candidates.push(candidate);
		} else if (argument === "--source") sourceIds.push(raw);
		else if (argument === "--domain") {
			if (!TASK_DOMAINS.includes(raw as ModelTaskDomain)) return null;
			domain = raw as ModelTaskDomain;
		} else if (argument === "--type") {
			if (!TASK_TYPES.includes(raw as ModelTaskType)) return null;
			type = raw as ModelTaskType;
		} else if (argument === "--scope") {
			if (raw !== "exact-session" && raw !== "available-models") return null;
			scopeAuthority = raw;
		} else if (argument === "--budget") budgetPressure = Number(raw);
		else if (argument === "--session-id") sessionId = raw;
		else if (argument === "--session-secret") sessionSecret = raw;
		else {
			const weight = Number(raw);
			if (!Number.isFinite(weight) || weight < 0 || weight > 10) return null;
			weights[argument!.slice("--weight-".length) as keyof UtilityWeights] = weight;
		}
	}
	if (action === "list" && query.sourceId === undefined) return null;
	if (
		action === "rank" &&
		(candidates.length === 0 ||
			sourceIds.length > MODEL_RANKING_MAX_SOURCES ||
			!Number.isFinite(budgetPressure) ||
			budgetPressure < 0 ||
			budgetPressure > 2)
	)
		return null;
	return {
		action,
		json,
		force,
		...(action === "list" ? { query: query as BenchmarkQuery } : {}),
		...(action === "rank"
			? {
					recommendation: {
						candidates,
						sourceIds: [...new Set(sourceIds)],
						scopeAuthority,
						domain,
						type,
						budgetPressure,
						weights,
						...(sessionId ? { session_id: sessionId } : {}),
						...(sessionSecret ? { session_secret: sessionSecret } : {}),
					},
				}
			: {}),
	};
}

export function formatBenchmarkStatus(result: BenchmarkRefreshResult): string {
	if (result.sources.length === 0) return "Benchmark sources: none configured";
	return [
		"Benchmark sources:",
		...result.sources.map((source) => {
			const state = source.ok === null ? "not refreshed" : source.ok ? "ready" : "refresh failed";
			return `- ${source.id}: ${state} · ${source.observations.toLocaleString()} observations · ${source.hasEvidence ? "evidence retained" : "no evidence"}`;
		}),
	].join("\n");
}

export function formatBenchmarkQuery(result: BenchmarkQueryResult): string {
	return [
		`Benchmark evidence: ${humanField(result.sourceId)} · ${result.completeness} · ${result.freshness} · ${result.observations.length.toLocaleString()} observations`,
		...result.observations.map(
			(observation) =>
				`- ${humanField(observation.model.canonical)} · ${humanField(observation.dimension)} ${observation.value.toLocaleString()} ${observation.unit} · ${humanField(observation.provenance.publisher)} · confidence ${(observation.provenance.confidence * 100).toFixed(0)}%`,
		),
	].join("\n");
}

export function formatModelRanking(result: ModelRankingResult): string {
	return [
		`Model ranking: ${result.completeness} · scope ${result.scopeAuthority}${result.scopeWarning ? " · advisory only" : ""}`,
		...result.ranked.map(
			(item, index) =>
				`${index + 1}. ${humanField(item.identity)} · utility ${item.utility === null ? "unknown" : item.utility.toFixed(3)} · confidence ${(item.confidence * 100).toFixed(0)}%`,
		),
		...(result.scopeWarning ? [result.scopeWarning] : []),
	].join("\n");
}

export async function runBenchmarksCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	const parsed = parseBenchmarkArgs(action, rest);
	if (!parsed) return usage();
	try {
		if (parsed.action === "list") {
			const result = await deps.client.call("benchmark.query", parsed.query!);
			deps.stdout(parsed.json ? JSON.stringify(result) : formatBenchmarkQuery(result));
		} else if (parsed.action === "rank") {
			const result = await deps.client.call("models.rank", parsed.recommendation!);
			deps.stdout(parsed.json ? JSON.stringify(result) : formatModelRanking(result));
		} else {
			const result =
				parsed.action === "refresh"
					? await deps.client.call("benchmark.refresh", { force: parsed.force })
					: await deps.client.call("benchmark.status", {});
			deps.stdout(parsed.json ? JSON.stringify(result) : formatBenchmarkStatus(result));
		}
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
