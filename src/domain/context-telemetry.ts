import {
	CONTEXT_OBSERVATION_MAX_AGE_MS,
	CONTEXT_OBSERVATION_MAX_CHARACTERS,
	MILLISECONDS_PER_HOUR,
	PAPYRUS_CONTEXT_INJECTION_SCHEMA,
} from "../constants.ts";
import type { MetricObservation, StoredMetricObservation } from "./metric.ts";

interface PayloadSize { characters: number; bytes: number }

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

const TOP_LEVEL_FIELDS = new Set(["schema", "observedAt", "sequence", "producerId", "before", "rules", "tasks", "injected", "after", "estimatedTokens", "share", "fingerprint", "unchanged"]);
const SIZE_FIELDS = new Set(["characters", "bytes"]);
const RULE_SIZE_FIELDS = new Set(["characters", "bytes", "count"]);

function record(value: unknown, name: string, fields: Set<string>): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result)) if (!fields.has(key)) throw new Error(`${name} contains unexpected field: ${key}`);
	return result;
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name} must be a bounded non-negative integer`);
	return value;
}

function size(value: unknown, name: string, fields = SIZE_FIELDS): PayloadSize {
	const input = record(value, name, fields);
	return {
		characters: integer(input["characters"], `${name}.characters`, CONTEXT_OBSERVATION_MAX_CHARACTERS),
		bytes: integer(input["bytes"], `${name}.bytes`, CONTEXT_OBSERVATION_MAX_CHARACTERS * 4),
	};
}

export function validatePapyrusContextInjection(value: unknown, now = Date.now()): PapyrusContextInjection {
	const input = record(value, "context injection", TOP_LEVEL_FIELDS);
	if (input["schema"] !== PAPYRUS_CONTEXT_INJECTION_SCHEMA) throw new Error("context injection schema is not supported");
	const observedAt = integer(input["observedAt"], "observedAt");
	if (Math.abs(now - observedAt) > CONTEXT_OBSERVATION_MAX_AGE_MS) throw new Error("context injection observation is stale");
	const producerId = input["producerId"];
	if (typeof producerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(producerId)) throw new Error("producerId must be a UUID");
	const before = size(input["before"], "before");
	const rulesInput = record(input["rules"], "rules", RULE_SIZE_FIELDS);
	const rules = { ...size(rulesInput, "rules", RULE_SIZE_FIELDS), count: integer(rulesInput["count"], "rules.count") };
	const tasks = size(input["tasks"], "tasks");
	const injected = size(input["injected"], "injected");
	const after = size(input["after"], "after");
	if (injected.characters !== rules.characters + tasks.characters || after.characters !== before.characters + injected.characters) {
		throw new Error("context injection sizes are inconsistent");
	}
	const estimatedTokens = integer(input["estimatedTokens"], "estimatedTokens", CONTEXT_OBSERVATION_MAX_CHARACTERS);
	const share = input["share"];
	if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) throw new Error("share must be a ratio");
	const fingerprint = input["fingerprint"];
	if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("fingerprint must be a SHA-256 hex digest");
	if (typeof input["unchanged"] !== "boolean") throw new Error("unchanged must be boolean");
	return {
		schema: PAPYRUS_CONTEXT_INJECTION_SCHEMA,
		observedAt,
		sequence: integer(input["sequence"], "sequence"),
		producerId,
		before,
		rules,
		tasks,
		injected,
		after,
		estimatedTokens,
		share,
		fingerprint,
		unchanged: input["unchanged"],
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

export interface CompactionStart {
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	contextPercent?: number;
	contextTokens?: number;
}

interface OpenCompaction extends CompactionStart { startedAt: number }
interface UsageCounters {
	turns: number;
	injectedCharacters: number;
	estimatedInjectedTokens: number;
	providerTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

function emptyCounters(): UsageCounters {
	return { turns: 0, injectedCharacters: 0, estimatedInjectedTokens: 0, providerTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export class CompactionTelemetry {
	private open: OpenCompaction | undefined;
	private counters = emptyCounters();
	private previousCompletedAt: number | undefined;

	hasOpenCompaction(): boolean { return this.open !== undefined; }
	observeTurn(): void { this.counters.turns += 1; }
	observeInjection(characters: number, estimatedTokens: number): void {
		this.counters.injectedCharacters += Math.max(0, characters);
		this.counters.estimatedInjectedTokens += Math.max(0, estimatedTokens);
	}
	observeProviderUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
		this.counters.providerTokens += Math.max(0, usage.input) + Math.max(0, usage.output);
		this.counters.cacheReadTokens += Math.max(0, usage.cacheRead);
		this.counters.cacheWriteTokens += Math.max(0, usage.cacheWrite);
	}

	begin(input: CompactionStart, now = Date.now()): MetricObservation {
		this.open = { ...input, startedAt: now };
		return { source: "pi-context", scope: "compaction", metric: "compaction-started", value: 1, unit: "count", observedAt: now, attributes: { ...input } };
	}

	complete(input: Pick<CompactionStart, "reason" | "willRetry">, now = Date.now()): MetricObservation {
		if (!this.open) return { source: "pi-context", scope: "compaction", metric: "compaction-unmatched", value: 1, unit: "count", observedAt: now, attributes: { ...input } };
		const open = this.open;
		this.open = undefined;
		const attributes = this.intervalAttributes(open, now);
		this.previousCompletedAt = now;
		this.counters = emptyCounters();
		return { source: "pi-context", scope: "compaction", metric: "compaction-duration", value: Math.max(0, now - open.startedAt), unit: "milliseconds", observedAt: now, attributes: { ...attributes, reason: input.reason, willRetry: input.willRetry } };
	}

	abort(now = Date.now(), abortReason = "aborted"): MetricObservation {
		const open = this.open;
		this.open = undefined;
		if (!open) return { source: "pi-context", scope: "compaction", metric: "compaction-unmatched", value: 1, unit: "count", observedAt: now, attributes: { abortReason } };
		const attributes = this.intervalAttributes(open, now);
		this.counters = emptyCounters();
		return { source: "pi-context", scope: "compaction", metric: "compaction-aborted", value: 1, unit: "count", observedAt: now, attributes: { ...attributes, reason: open.reason, abortReason, durationMs: Math.max(0, now - open.startedAt) } };
	}

	private intervalAttributes(open: OpenCompaction, now: number): Record<string, unknown> {
		return {
			reason: open.reason,
			willRetry: open.willRetry,
			...(open.contextPercent === undefined ? {} : { contextPercent: open.contextPercent }),
			...(open.contextTokens === undefined ? {} : { contextTokens: open.contextTokens }),
			turnsSincePrevious: this.counters.turns,
			injectedCharactersSincePrevious: this.counters.injectedCharacters,
			estimatedInjectedTokensSincePrevious: this.counters.estimatedInjectedTokens,
			providerTokensSincePrevious: this.counters.providerTokens,
			cacheReadTokensSincePrevious: this.counters.cacheReadTokens,
			cacheWriteTokensSincePrevious: this.counters.cacheWriteTokens,
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
		reasons: Record<"manual" | "threshold" | "overflow", number>;
	};
}

function numericAttribute(row: StoredMetricObservation, key: string): number | null {
	const value = row.attributes[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function average(values: number[]): number | null { return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
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
	const injectionValues = injections.flatMap((row) => typeof row.value === "number" ? [row.value] : []);
	const shares = injections.flatMap((row) => numericAttribute(row, "share") ?? []);
	const unchanged = injections.filter((row) => row.attributes["unchanged"] === true).length;
	const completed = compactions.filter((row) => row.metric === "compaction-duration" && typeof row.value === "number");
	const aborted = compactions.filter((row) => row.metric === "compaction-aborted");
	const reasons = { manual: 0, threshold: 0, overflow: 0 };
	for (const row of completed) {
		const reason = row.attributes["reason"];
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
			reasons,
		},
	};
}
