import { BENCHMARK_MAX_OBSERVATIONS_PER_SNAPSHOT, MAX_DYNAMIC_ROUTES, MODEL_AGGREGATE_MAX_ROWS } from "../constants.ts";
import { normalizeModelIdentity, type BenchmarkObservation } from "./benchmark.ts";
import { TASK_CLASSES, type ModelMetricAggregate, type ModelTaskClass } from "./model-observation.ts";

export type ScopeAuthority = "exact-session" | "available-models";
export type UtilityComponentName = "quality" | "cost" | "latency" | "context" | "reliability";

export interface ModelCandidate {
	provider: string;
	model: string;
	thinking: string;
}

export interface UtilityWeights {
	quality: number;
	cost: number;
	latency: number;
	context: number;
	reliability: number;
}

export interface ModelRankingInput {
	candidates: ModelCandidate[];
	scopeAuthority: ScopeAuthority;
	taskClass: ModelTaskClass;
	budgetPressure: number;
	weights: UtilityWeights;
	externalEvidence: BenchmarkObservation[];
	localEvidence: ModelMetricAggregate[];
	now: number;
}

export interface UtilityComponent {
	name: UtilityComponentName;
	score: number | null;
	confidence: number;
	weight: number;
	evidenceCount: number;
	reason: string;
}

export interface RankingProvenance {
	sourceId: string;
	publisher: string;
	url: string;
	revision: string;
	freshness: "fresh" | "stale";
}

export interface RankedModel {
	candidate: ModelCandidate;
	identity: string;
	utility: number | null;
	confidence: number;
	components: UtilityComponent[];
	provenance: RankingProvenance[];
	trace: string[];
}

export interface ModelRankingResult {
	scopeAuthority: ScopeAuthority;
	scopeWarning: string | null;
	taskClass: ModelTaskClass;
	completeness: "complete" | "partial" | "insufficient-evidence";
	ranked: RankedModel[];
	automaticSelection: ModelCandidate | null;
}

interface RawComponent {
	value: number | null;
	confidence: number;
	evidenceCount: number;
	reason: string;
	lowerIsBetter: boolean;
}

const COMPONENTS: UtilityComponentName[] = ["quality", "cost", "latency", "context", "reliability"];

function finiteBound(value: number, name: string, minimum: number, maximum: number): number {
	if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is outside its supported range`);
	return value;
}

function candidateIdentity(candidate: ModelCandidate): string {
	const identity = normalizeModelIdentity(candidate.provider, candidate.model);
	if (typeof candidate.thinking !== "string" || candidate.thinking.length === 0 || candidate.thinking.length > 160) throw new Error("candidate thinking level is invalid");
	return `${identity.canonical}:${candidate.thinking}`;
}

function average(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function externalValues(candidate: ModelCandidate, evidence: BenchmarkObservation[], dimensions: string[], now: number): { values: number[]; confidences: number[]; provenance: RankingProvenance[] } {
	const identity = normalizeModelIdentity(candidate.provider, candidate.model);
	const matching = evidence.filter((item) => (item.model.canonical === identity.canonical || item.model.aliases.includes(identity.canonical)) && dimensions.includes(item.dimension));
	return {
		values: matching.map((item) => item.value),
		confidences: matching.map((item) => item.provenance.confidence * (now <= item.provenance.freshUntil ? 1 : 0.25)),
		provenance: matching.map((item) => ({ sourceId: item.provenance.sourceId, publisher: item.provenance.publisher, url: item.provenance.url, revision: item.provenance.revision, freshness: now <= item.provenance.freshUntil ? "fresh" : "stale" })),
	};
}

function localValues(candidate: ModelCandidate, taskClass: ModelTaskClass, evidence: ModelMetricAggregate[], dimension: string): ModelMetricAggregate[] {
	const identity = normalizeModelIdentity(candidate.provider, candidate.model);
	return evidence.filter((item) => item.provider === identity.provider && item.model === identity.model && item.thinking === candidate.thinking && item.taskClass === taskClass && item.dimension === dimension);
}

function rawComponents(candidate: ModelCandidate, input: ModelRankingInput): { components: Record<UtilityComponentName, RawComponent>; provenance: RankingProvenance[] } {
	const quality = externalValues(candidate, input.externalEvidence, [`quality-${input.taskClass}`, "quality-general"], input.now);
	const priceInput = externalValues(candidate, input.externalEvidence, ["price-input"], input.now);
	const priceOutput = externalValues(candidate, input.externalEvidence, ["price-output"], input.now);
	const measuredLatency = externalValues(candidate, input.externalEvidence, ["latency"], input.now);
	const rankedLatency = externalValues(candidate, input.externalEvidence, ["latency-rank", "throughput-rank"], input.now);
	const latency = measuredLatency.values.length > 0 ? measuredLatency : rankedLatency;
	const context = externalValues(candidate, input.externalEvidence, ["context-window"], input.now);
	const localLatency = localValues(candidate, input.taskClass, input.localEvidence, "wall-latency");
	const failures = localValues(candidate, input.taskClass, input.localEvidence, "failure");
	const outcomes = localValues(candidate, input.taskClass, input.localEvidence, "outcome-accepted");
	const qualityValues = quality.values;
	const prices = [...priceInput.values, ...priceOutput.values];
	const latencyValues = localLatency.length > 0 ? localLatency.map((item) => item.median) : latency.values;
	const latencyConfidences = localLatency.length > 0 ? localLatency.map((item) => item.confidence) : latency.confidences;
	const reliabilityValues = [...failures.map((item) => 1 - item.median), ...outcomes.map((item) => item.median)];
	const withEvidence = (values: number[], confidences: number[], lowerIsBetter: boolean, label: string): RawComponent => values.length === 0
		? { value: null, confidence: 0, evidenceCount: 0, reason: `${label} evidence is missing`, lowerIsBetter }
		: {
			value: average(values),
			confidence: average(confidences) / (1 + ((Math.max(...values) - Math.min(...values)) / Math.max(Math.abs(average(values)), Number.EPSILON))),
			evidenceCount: values.length,
			reason: `${values.length} ${label} observation${values.length === 1 ? "" : "s"}`,
			lowerIsBetter,
		};
	const components: Record<UtilityComponentName, RawComponent> = {
		quality: withEvidence(qualityValues, quality.confidences, false, "task quality"),
		cost: withEvidence(prices, [...priceInput.confidences, ...priceOutput.confidences], true, "price"),
		latency: withEvidence(latencyValues, latencyConfidences, true, "latency"),
		context: withEvidence(context.values, context.confidences, false, "context window"),
		reliability: withEvidence(reliabilityValues, [...failures, ...outcomes].map((item) => item.confidence), false, "local reliability"),
	};
	return { components, provenance: [...quality.provenance, ...priceInput.provenance, ...priceOutput.provenance, ...latency.provenance, ...context.provenance] };
}

function normalizedScore(value: number, values: number[], lowerIsBetter: boolean): number {
	const minimum = Math.min(...values);
	const maximum = Math.max(...values);
	if (maximum === minimum) return 0.5;
	const score = (value - minimum) / (maximum - minimum);
	return lowerIsBetter ? 1 - score : score;
}

export function rankModelCandidates(value: ModelRankingInput): ModelRankingResult {
	if (!Array.isArray(value.candidates) || value.candidates.length === 0 || value.candidates.length > MAX_DYNAMIC_ROUTES) throw new Error("candidate count is outside its supported range");
	if (!Array.isArray(value.externalEvidence) || value.externalEvidence.length > BENCHMARK_MAX_OBSERVATIONS_PER_SNAPSHOT * 4) throw new Error("external evidence exceeds the supported bound");
	if (!Array.isArray(value.localEvidence) || value.localEvidence.length > MODEL_AGGREGATE_MAX_ROWS) throw new Error("local evidence exceeds the supported bound");
	if (value.scopeAuthority !== "exact-session" && value.scopeAuthority !== "available-models") throw new Error("scope authority is invalid");
	if (!TASK_CLASSES.includes(value.taskClass)) throw new Error("task class is invalid");
	if (!Number.isSafeInteger(value.now) || value.now <= 0) throw new Error("ranking time is invalid");
	const budgetPressure = finiteBound(value.budgetPressure, "budget pressure", 0, 2);
	const weights = Object.fromEntries(COMPONENTS.map((name) => [name, finiteBound(value.weights[name], `${name} weight`, 0, 10)])) as unknown as UtilityWeights;
	const seen = new Set<string>();
	const candidates = value.candidates.map((candidate) => ({ ...candidate })).filter((candidate) => {
		const identity = candidateIdentity(candidate);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
	const raw = candidates.map((candidate) => rawComponents(candidate, value));
	const effectiveWeights: UtilityWeights = { ...weights, cost: weights.cost * (1 + budgetPressure) };
	const ranked = candidates.map((candidate, index): RankedModel => {
		const source = raw[index]!;
		const components = COMPONENTS.map((name): UtilityComponent => {
			const component = source.components[name];
			const comparable = raw.map((item) => item.components[name].value).filter((item): item is number => item !== null);
			return {
				name,
				score: component.value === null ? null : normalizedScore(component.value, comparable, component.lowerIsBetter),
				confidence: component.confidence,
				weight: effectiveWeights[name],
				evidenceCount: component.evidenceCount,
				reason: component.reason,
			};
		});
		const known = components.filter((component): component is UtilityComponent & { score: number } => component.score !== null && component.weight > 0);
		const knownWeight = known.reduce((sum, component) => sum + component.weight, 0);
		const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
		const utility = knownWeight === 0 ? null : known.reduce((sum, component) => sum + (component.score * component.weight), 0) / knownWeight;
		const confidence = totalWeight === 0 ? 0 : known.reduce((sum, component) => sum + (component.confidence * component.weight), 0) / totalWeight;
		const provenance = [...new Map(source.provenance.map((item) => [`${item.sourceId}:${item.revision}:${item.url}`, item])).values()]
			.sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.revision.localeCompare(right.revision));
		return {
			candidate,
			identity: candidateIdentity(candidate),
			utility,
			confidence,
			components,
			provenance,
			trace: [`task class ${value.taskClass}`, `budget pressure ${budgetPressure.toFixed(3)} makes cost weight ${effectiveWeights.cost.toFixed(3)}`, `${known.length}/${components.length} utility components have evidence`, `scope authority ${value.scopeAuthority}`],
		};
	}).sort((left, right) => (right.utility ?? -1) - (left.utility ?? -1) || right.confidence - left.confidence || left.identity.localeCompare(right.identity));
	const knownComponents = ranked.reduce((sum, item) => sum + item.components.filter((component) => component.score !== null).length, 0);
	const possibleComponents = ranked.length * COMPONENTS.length;
	const completeness = knownComponents === 0 ? "insufficient-evidence" : knownComponents === possibleComponents ? "complete" : "partial";
	const exact = value.scopeAuthority === "exact-session";
	return {
		scopeAuthority: value.scopeAuthority,
		scopeWarning: exact ? null : "Pi available models are not the exact session scope; automatic selection is disabled",
		taskClass: value.taskClass,
		completeness,
		ranked,
		automaticSelection: exact && ranked[0]?.utility !== null ? ranked[0]!.candidate : null,
	};
}
