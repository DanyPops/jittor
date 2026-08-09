import {
	COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES,
	COMPACTION_DURATION_ESTIMATE_MIN_SAMPLES,
	CONTEXT_OBSERVATION_MAX_AGE_MS,
	CONTEXT_OBSERVATION_MAX_CHARACTERS,
	MILLISECONDS_PER_HOUR,
	PAPYRUS_CONTEXT_INJECTION_SCHEMA,
} from "../constants.ts";
import type { MetricObservation, StoredMetricObservation } from "./metric.ts";
import type { TokenMeasurementProvenance } from "./token-measurement.ts";

interface PayloadSize {
	characters: number;
	bytes: number;
}

export interface PapyrusContextInjection {
	schema: typeof PAPYRUS_CONTEXT_INJECTION_SCHEMA;
	observedAt: number;
	sequence: number;
	producerId: string;
	before: PayloadSize;
	rules: PayloadSize & { count: number };
	tasks: PayloadSize;
	injected: PayloadSize;
	after: PayloadSize;
	estimatedTokens: number;
	share: number;
	fingerprint: string;
	unchanged: boolean;
}

const TOP_LEVEL_FIELDS = new Set([
	"schema",
	"observedAt",
	"sequence",
	"producerId",
	"before",
	"rules",
	"tasks",
	"injected",
	"after",
	"estimatedTokens",
	"share",
	"fingerprint",
	"unchanged",
]);
const SIZE_FIELDS = new Set(["characters", "bytes"]);
const RULE_SIZE_FIELDS = new Set(["characters", "bytes", "count"]);

function record(value: unknown, name: string, fields: Set<string>): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result)) if (!fields.has(key)) throw new Error(`${name} contains unexpected field: ${key}`);
	return result;
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new Error(`${name} must be a bounded non-negative integer`);
	return value;
}

function size(value: unknown, name: string, fields = SIZE_FIELDS): PayloadSize {
	const input = record(value, name, fields);
	return {
		characters: integer(input.characters, `${name}.characters`, CONTEXT_OBSERVATION_MAX_CHARACTERS),
		bytes: integer(input.bytes, `${name}.bytes`, CONTEXT_OBSERVATION_MAX_CHARACTERS * 4),
	};
}

export function validatePapyrusContextInjection(value: unknown, now = Date.now()): PapyrusContextInjection {
	const input = record(value, "context injection", TOP_LEVEL_FIELDS);
	if (input.schema !== PAPYRUS_CONTEXT_INJECTION_SCHEMA) throw new Error("context injection schema is not supported");
	const observedAt = integer(input.observedAt, "observedAt");
	if (Math.abs(now - observedAt) > CONTEXT_OBSERVATION_MAX_AGE_MS) throw new Error("context injection observation is stale");
	const producerId = input.producerId;
	if (typeof producerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(producerId))
		throw new Error("producerId must be a UUID");
	const before = size(input.before, "before");
	const rulesInput = record(input.rules, "rules", RULE_SIZE_FIELDS);
	const rules = { ...size(rulesInput, "rules", RULE_SIZE_FIELDS), count: integer(rulesInput.count, "rules.count") };
	const tasks = size(input.tasks, "tasks");
	const injected = size(input.injected, "injected");
	const after = size(input.after, "after");
	if (injected.characters !== rules.characters + tasks.characters || after.characters !== before.characters + injected.characters) {
		throw new Error("context injection sizes are inconsistent");
	}
	const estimatedTokens = integer(input.estimatedTokens, "estimatedTokens", CONTEXT_OBSERVATION_MAX_CHARACTERS);
	const share = input.share;
	if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) throw new Error("share must be a ratio");
	const fingerprint = input.fingerprint;
	if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("fingerprint must be a SHA-256 hex digest");
	if (typeof input.unchanged !== "boolean") throw new Error("unchanged must be boolean");
	return {
		schema: PAPYRUS_CONTEXT_INJECTION_SCHEMA,
		observedAt,
		sequence: integer(input.sequence, "sequence"),
		producerId,
		before,
		rules,
		tasks,
		injected,
		after,
		estimatedTokens,
		share,
		fingerprint,
		unchanged: input.unchanged,
	};
}

export function papyrusContextMetric(observation: PapyrusContextInjection): MetricObservation {
	return {
		source: "papyrus-context",
		scope: "system-prompt",
		metric: "injected-characters",
		value: observation.injected.characters,
		unit: "count",
		observedAt: observation.observedAt,
		attributes: {
			sequence: observation.sequence,
			producerId: observation.producerId,
			beforeCharacters: observation.before.characters,
			afterCharacters: observation.after.characters,
			injectedBytes: observation.injected.bytes,
			ruleCharacters: observation.rules.characters,
			taskCharacters: observation.tasks.characters,
			ruleCount: observation.rules.count,
			estimatedTokens: observation.estimatedTokens,
			share: observation.share,
			fingerprint: observation.fingerprint,
			unchanged: observation.unchanged,
		},
	};
}

export type CompactionMechanism = "pi-native" | "provider-side" | "extension";

export interface CompactionStart {
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	mechanism?: CompactionMechanism;
	contextPercent?: number;
	contextTokens?: number;
	contextProvenance?: TokenMeasurementProvenance;
	provider?: string;
	model?: string;
}

export interface CompactionCompletion extends Pick<CompactionStart, "reason" | "willRetry"> {
	mechanism?: CompactionMechanism;
	summaryTokens?: number;
	summaryProvenance?: TokenMeasurementProvenance;
}

interface OpenCompaction extends CompactionStart {
	mechanism: CompactionMechanism;
	startedAt: number;
}

interface PendingEffectiveness {
	preContextTokens: number;
	preContextProvenance: TokenMeasurementProvenance;
	mechanism: CompactionMechanism;
	provider?: string;
	model?: string;
	summaryTokens?: number;
	summaryProvenance?: TokenMeasurementProvenance;
	completedAt: number;
}

interface RegrowthState {
	preContextTokens: number;
	completedAt: number;
	turns: number;
	emitted: Set<number>;
	mechanism: CompactionMechanism;
	provider?: string;
	model?: string;
}
interface UsageCounters {
	turns: number;
	injectedCharacters: number;
	estimatedInjectedTokens: number;
	providerTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	toolCalls: number;
	toolFailures: number;
	toolClasses: Map<string, number>;
	acceptedOutcomes: number;
	rejectedOutcomes: number;
}

function emptyCounters(): UsageCounters {
	return {
		turns: 0,
		injectedCharacters: 0,
		estimatedInjectedTokens: 0,
		providerTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		toolCalls: 0,
		toolFailures: 0,
		toolClasses: new Map(),
		acceptedOutcomes: 0,
		rejectedOutcomes: 0,
	};
}

export class CompactionTelemetry {
	private open: OpenCompaction | undefined;
	private counters = emptyCounters();
	private previousCompletedAt: number | undefined;
	private pendingEffectiveness: PendingEffectiveness | undefined;
	private regrowth: RegrowthState | undefined;

	hasOpenCompaction(): boolean {
		return this.open !== undefined;
	}
	observeTurn(): void {
		this.counters.turns += 1;
		if (this.regrowth) this.regrowth.turns += 1;
	}
	observeInjection(characters: number, estimatedTokens: number): void {
		this.counters.injectedCharacters += Math.max(0, characters);
		this.counters.estimatedInjectedTokens += Math.max(0, estimatedTokens);
	}
	observeProviderUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
		this.counters.providerTokens += Math.max(0, usage.input) + Math.max(0, usage.output);
		this.counters.cacheReadTokens += Math.max(0, usage.cacheRead);
		this.counters.cacheWriteTokens += Math.max(0, usage.cacheWrite);
	}
	observeToolClass(toolClass: string, failed: boolean): void {
		if (!/^[a-z][a-z0-9-]{0,31}$/.test(toolClass)) return;
		this.counters.toolCalls += 1;
		if (failed) this.counters.toolFailures += 1;
		if (this.counters.toolClasses.size < 16 || this.counters.toolClasses.has(toolClass))
			this.counters.toolClasses.set(toolClass, (this.counters.toolClasses.get(toolClass) ?? 0) + 1);
	}
	observeOutcome(outcome: "accepted" | "rejected"): void {
		if (outcome === "accepted") this.counters.acceptedOutcomes += 1;
		else this.counters.rejectedOutcomes += 1;
	}

	begin(input: CompactionStart, now = Date.now()): MetricObservation {
		if (this.open) {
			return {
				source: "pi-context",
				scope: "compaction",
				metric: "compaction-overlap",
				value: 1,
				unit: "count",
				observedAt: now,
				attributes: { reason: input.reason, willRetry: input.willRetry, openReason: this.open.reason },
			};
		}
		this.open = { ...input, mechanism: input.mechanism ?? "pi-native", startedAt: now };
		return {
			source: "pi-context",
			scope: "compaction",
			metric: "compaction-started",
			value: 1,
			unit: "count",
			observedAt: now,
			attributes: { ...input },
		};
	}

	complete(input: CompactionCompletion, now = Date.now()): MetricObservation {
		if (!this.open)
			return {
				source: "pi-context",
				scope: "compaction",
				metric: "compaction-unmatched",
				value: 1,
				unit: "count",
				observedAt: now,
				attributes: { ...input },
			};
		const open = this.open;
		this.open = undefined;
		const attributes = this.intervalAttributes(open, now);
		this.previousCompletedAt = now;
		this.counters = emptyCounters();
		if (typeof open.contextTokens === "number" && Number.isSafeInteger(open.contextTokens) && open.contextTokens > 0) {
			this.pendingEffectiveness = {
				preContextTokens: open.contextTokens,
				preContextProvenance: open.contextProvenance ?? "provider-reported",
				mechanism: input.mechanism ?? open.mechanism,
				...(open.provider === undefined ? {} : { provider: open.provider }),
				...(open.model === undefined ? {} : { model: open.model }),
				...(input.summaryTokens === undefined ? {} : { summaryTokens: Math.max(0, Math.round(input.summaryTokens)) }),
				...(input.summaryProvenance === undefined ? {} : { summaryProvenance: input.summaryProvenance }),
				completedAt: now,
			};
		}
		return {
			source: "pi-context",
			scope: "compaction",
			metric: "compaction-duration",
			value: Math.max(0, now - open.startedAt),
			unit: "milliseconds",
			observedAt: now,
			attributes: {
				...attributes,
				reason: input.reason,
				willRetry: input.willRetry,
				mechanism: input.mechanism ?? open.mechanism,
				...(input.summaryTokens === undefined ? {} : { summaryTokens: Math.max(0, Math.round(input.summaryTokens)) }),
				...(input.summaryProvenance === undefined ? {} : { summaryProvenance: input.summaryProvenance }),
			},
		};
	}

	/** Correlates the first post-compaction request, then reports bounded 50/80/100% regrowth milestones once each. */
	observeContextSnapshot(
		tokens: number,
		provenance: TokenMeasurementProvenance,
		now = Date.now(),
		identity?: { provider: string; model: string },
	): MetricObservation[] {
		if (!Number.isSafeInteger(tokens) || tokens < 0) return [];
		const observations: MetricObservation[] = [];
		if (this.pendingEffectiveness) {
			const pending = this.pendingEffectiveness;
			this.pendingEffectiveness = undefined;
			const identityChange =
				identity && pending.provider && identity.provider !== pending.provider
					? "provider-changed"
					: identity && pending.model && identity.model !== pending.model
						? "model-changed"
						: null;
			if (identityChange) {
				this.regrowth = undefined;
				return [
					{
						source: "pi-context",
						scope: "compaction",
						metric: "compaction-effectiveness-unavailable",
						value: 1,
						unit: "count",
						observedAt: now,
						attributes: { reason: identityChange, mechanism: pending.mechanism },
					},
				];
			}
			const reduction = (pending.preContextTokens - tokens) / pending.preContextTokens;
			observations.push({
				source: "pi-context",
				scope: "compaction",
				metric: "compaction-effectiveness",
				value: reduction,
				unit: "ratio",
				observedAt: now,
				attributes: {
					mechanism: pending.mechanism,
					preContextTokens: pending.preContextTokens,
					postContextTokens: tokens,
					preContextProvenance: pending.preContextProvenance,
					postContextProvenance: provenance,
					...(pending.provider === undefined ? {} : { provider: pending.provider }),
					...(pending.model === undefined ? {} : { model: pending.model }),
					...(pending.summaryTokens === undefined ? {} : { summaryTokens: pending.summaryTokens }),
					...(pending.summaryProvenance === undefined ? {} : { summaryProvenance: pending.summaryProvenance }),
				},
			});
			this.regrowth = {
				preContextTokens: pending.preContextTokens,
				completedAt: pending.completedAt,
				turns: 0,
				emitted: new Set(),
				mechanism: pending.mechanism,
				...(pending.provider === undefined ? {} : { provider: pending.provider }),
				...(pending.model === undefined ? {} : { model: pending.model }),
			};
			return observations;
		}
		const regrowth = this.regrowth;
		if (!regrowth) return observations;
		const fraction = tokens / regrowth.preContextTokens;
		for (const threshold of [0.5, 0.8, 1]) {
			if (fraction < threshold || regrowth.emitted.has(threshold)) continue;
			regrowth.emitted.add(threshold);
			observations.push({
				source: "pi-context",
				scope: "compaction",
				metric: "compaction-regrowth",
				value: threshold,
				unit: "ratio",
				observedAt: now,
				attributes: {
					threshold,
					contextTokens: tokens,
					contextProvenance: provenance,
					turnsSinceCompaction: regrowth.turns,
					elapsedSinceCompactionMs: Math.max(0, now - regrowth.completedAt),
					mechanism: regrowth.mechanism,
					...(regrowth.provider === undefined ? {} : { provider: regrowth.provider }),
					...(regrowth.model === undefined ? {} : { model: regrowth.model }),
				},
			});
		}
		return observations;
	}

	abort(now = Date.now(), abortReason = "aborted"): MetricObservation {
		const open = this.open;
		this.open = undefined;
		if (!open)
			return {
				source: "pi-context",
				scope: "compaction",
				metric: "compaction-unmatched",
				value: 1,
				unit: "count",
				observedAt: now,
				attributes: { abortReason },
			};
		const attributes = this.intervalAttributes(open, now);
		this.counters = emptyCounters();
		return {
			source: "pi-context",
			scope: "compaction",
			metric: "compaction-aborted",
			value: 1,
			unit: "count",
			observedAt: now,
			attributes: { ...attributes, reason: open.reason, abortReason, durationMs: Math.max(0, now - open.startedAt) },
		};
	}

	private intervalAttributes(open: OpenCompaction, now: number): Record<string, unknown> {
		return {
			reason: open.reason,
			willRetry: open.willRetry,
			mechanism: open.mechanism,
			...(open.contextProvenance === undefined ? {} : { contextProvenance: open.contextProvenance }),
			...(open.provider === undefined ? {} : { provider: open.provider }),
			...(open.model === undefined ? {} : { model: open.model }),
			...(open.contextPercent === undefined ? {} : { contextPercent: open.contextPercent }),
			...(open.contextTokens === undefined ? {} : { contextTokens: open.contextTokens }),
			turnsSincePrevious: this.counters.turns,
			injectedCharactersSincePrevious: this.counters.injectedCharacters,
			estimatedInjectedTokensSincePrevious: this.counters.estimatedInjectedTokens,
			providerTokensSincePrevious: this.counters.providerTokens,
			cacheReadTokensSincePrevious: this.counters.cacheReadTokens,
			cacheWriteTokensSincePrevious: this.counters.cacheWriteTokens,
			toolCallsSincePrevious: this.counters.toolCalls,
			toolFailuresSincePrevious: this.counters.toolFailures,
			repeatedToolClassesSincePrevious: [...this.counters.toolClasses.entries()]
				.filter(([, count]) => count > 1)
				.map(([name, count]) => `${name}:${count}`),
			acceptedOutcomesSincePrevious: this.counters.acceptedOutcomes,
			rejectedOutcomesSincePrevious: this.counters.rejectedOutcomes,
			...(this.previousCompletedAt === undefined ? {} : { elapsedSincePreviousMs: Math.max(0, now - this.previousCompletedAt) }),
		};
	}
}

export interface ContextAssessment {
	window: { since: number; until: number };
	completeness: "complete" | "truncated";
	injection: {
		runs: number;
		averageCharacters: number | null;
		p95Characters: number | null;
		maxCharacters: number | null;
		estimatedTokens: number;
		unchangedRate: number | null;
		averageShare: number | null;
		ruleCharacters: number;
		taskCharacters: number;
	};
	compaction: {
		completed: number;
		aborted: number;
		averageDurationMs: number | null;
		perRun: number | null;
		perTurn: number | null;
		perHour: number | null;
		averageTurnsBetween: number | null;
		averageElapsedMsBetween: number | null;
		averageProviderTokensBetween: number | null;
		averageCacheReadTokensBetween: number | null;
		effectivenessSamples: number;
		averageReductionRatio: number | null;
		averagePreContextTokens: number | null;
		averagePostContextTokens: number | null;
		mechanisms: Record<CompactionMechanism, number>;
		regrowth: Record<"50" | "80" | "100", { samples: number; averageTurns: number | null; averageElapsedMs: number | null } | null>;
		reasons: Record<"manual" | "threshold" | "overflow", number>;
	};
}

function numericAttribute(row: StoredMetricObservation, key: string): number | null {
	const value = row.attributes[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function average(values: number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
function percentile(values: number[], percentage: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * percentage) - 1)]!;
}

export function assessContextTelemetry(
	injections: StoredMetricObservation[],
	compactions: StoredMetricObservation[],
	options: { since: number; until: number; truncated: boolean },
): ContextAssessment {
	const injectionValues = injections.flatMap((row) => (typeof row.value === "number" ? [row.value] : []));
	const shares = injections.flatMap((row) => numericAttribute(row, "share") ?? []);
	const unchanged = injections.filter((row) => row.attributes.unchanged === true).length;
	const completed = compactions.filter((row) => row.metric === "compaction-duration" && typeof row.value === "number");
	const aborted = compactions.filter((row) => row.metric === "compaction-aborted");
	const effectiveness = compactions.filter(
		(row) => row.metric === "compaction-effectiveness" && typeof row.value === "number" && Number.isFinite(row.value),
	);
	const regrowthRows = compactions.filter((row) => row.metric === "compaction-regrowth");
	const mechanisms: Record<CompactionMechanism, number> = { "pi-native": 0, "provider-side": 0, extension: 0 };
	for (const row of effectiveness) {
		const mechanism = row.attributes.mechanism;
		if (mechanism === "pi-native" || mechanism === "provider-side" || mechanism === "extension") mechanisms[mechanism] += 1;
	}
	const regrowth = (threshold: number): { samples: number; averageTurns: number | null; averageElapsedMs: number | null } | null => {
		const rows = regrowthRows.filter((row) => row.attributes.threshold === threshold);
		if (rows.length === 0) return null;
		return {
			samples: rows.length,
			averageTurns: average(rows.flatMap((row) => numericAttribute(row, "turnsSinceCompaction") ?? [])),
			averageElapsedMs: average(rows.flatMap((row) => numericAttribute(row, "elapsedSinceCompactionMs") ?? [])),
		};
	};
	const reasons = { manual: 0, threshold: 0, overflow: 0 };
	for (const row of completed) {
		const reason = row.attributes.reason;
		if (reason === "manual" || reason === "threshold" || reason === "overflow") reasons[reason] += 1;
	}
	const windowMs = Math.max(0, options.until - options.since);
	const turnsBetween = completed.flatMap((row) => numericAttribute(row, "turnsSincePrevious") ?? []);
	return {
		window: { since: options.since, until: options.until },
		completeness: options.truncated ? "truncated" : "complete",
		injection: {
			runs: injections.length,
			averageCharacters: average(injectionValues),
			p95Characters: percentile(injectionValues, 0.95),
			maxCharacters: injectionValues.length === 0 ? null : Math.max(...injectionValues),
			estimatedTokens: sum(injections.flatMap((row) => numericAttribute(row, "estimatedTokens") ?? [])),
			unchangedRate: injections.length === 0 ? null : unchanged / injections.length,
			averageShare: average(shares),
			ruleCharacters: sum(injections.flatMap((row) => numericAttribute(row, "ruleCharacters") ?? [])),
			taskCharacters: sum(injections.flatMap((row) => numericAttribute(row, "taskCharacters") ?? [])),
		},
		compaction: {
			completed: completed.length,
			aborted: aborted.length,
			averageDurationMs: average(completed.map((row) => row.value as number)),
			perRun: injections.length === 0 ? null : completed.length / injections.length,
			perTurn: sum(turnsBetween) === 0 ? null : completed.length / sum(turnsBetween),
			perHour: completed.length === 0 || windowMs === 0 ? null : completed.length / (windowMs / MILLISECONDS_PER_HOUR),
			averageTurnsBetween: average(turnsBetween),
			averageElapsedMsBetween: average(completed.flatMap((row) => numericAttribute(row, "elapsedSincePreviousMs") ?? [])),
			averageProviderTokensBetween: average(completed.flatMap((row) => numericAttribute(row, "providerTokensSincePrevious") ?? [])),
			averageCacheReadTokensBetween: average(completed.flatMap((row) => numericAttribute(row, "cacheReadTokensSincePrevious") ?? [])),
			effectivenessSamples: effectiveness.length,
			averageReductionRatio: average(effectiveness.map((row) => row.value as number)),
			averagePreContextTokens: average(effectiveness.flatMap((row) => numericAttribute(row, "preContextTokens") ?? [])),
			averagePostContextTokens: average(effectiveness.flatMap((row) => numericAttribute(row, "postContextTokens") ?? [])),
			mechanisms,
			regrowth: { "50": regrowth(0.5), "80": regrowth(0.8), "100": regrowth(1) },
			reasons,
		},
	};
}

export interface CompactionDurationEstimate {
	ms: number | null;
	confidence: "cold-start" | "learned";
	sampleSize: number;
	observedAt: number;
}

/**
 * Learns a bounded duration estimate from the most recent completed Pi compactions so the drain
 * animation can show an approximate time-to-completion instead of a fixed-rate guess. Reads only
 * the numeric `compaction-duration` value already recorded content-free by CompactionTelemetry
 * (never transcript content, credentials, or attributes) and is bounded to the caller-provided
 * rows — callers must query with `limit: COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES` so retention is
 * bounded at the query layer, not just here. Below COMPACTION_DURATION_ESTIMATE_MIN_SAMPLES samples
 * the estimate stays explicit cold-start uncertainty rather than a guess from too little evidence.
 */
export function estimateCompactionDuration(compactions: StoredMetricObservation[], now = Date.now()): CompactionDurationEstimate {
	const durations = compactions
		.filter((row) => row.source === "pi-context" && row.scope === "compaction" && row.metric === "compaction-duration")
		.sort((left, right) => right.observedAt - left.observedAt || right.id - left.id)
		.slice(0, COMPACTION_DURATION_ESTIMATE_MAX_SAMPLES)
		.flatMap((row) => (typeof row.value === "number" && Number.isFinite(row.value) && row.value >= 0 ? [row.value] : []));
	if (durations.length < COMPACTION_DURATION_ESTIMATE_MIN_SAMPLES) {
		return { ms: null, confidence: "cold-start", sampleSize: durations.length, observedAt: now };
	}
	const median = percentile(durations, 0.5);
	return { ms: median === null ? null : Math.round(median), confidence: "learned", sampleSize: durations.length, observedAt: now };
}
