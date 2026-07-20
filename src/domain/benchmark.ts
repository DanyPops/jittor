import {
	BENCHMARK_DEFAULT_QUERY_LIMIT,
	BENCHMARK_IDENTITY_MAX_CHARACTERS,
	BENCHMARK_MAX_OBSERVATIONS_PER_SNAPSHOT,
	BENCHMARK_MAX_QUERY_LIMIT,
	BENCHMARK_MAX_TEXT_CHARACTERS,
	BENCHMARK_REFRESH_INTERVAL_MS,
} from "../constants.ts";
import { METRIC_UNITS, type MetricUnit } from "./metric.ts";
import type { BenchmarkController } from "../ports/benchmark-controller.ts";
import type { BenchmarkSource as BenchmarkSourcePort } from "../ports/benchmark-source.ts";
import type { BenchmarkStore } from "../ports/benchmark-store.ts";

export type BenchmarkSourceType = "creator" | "marketplace" | "independent" | "operational" | "preference" | "local";

export interface ModelIdentity {
	provider: string;
	model: string;
	version: string | null;
	canonical: string;
	aliases: string[];
}

export interface BenchmarkProvenance {
	sourceId: string;
	sourceType: BenchmarkSourceType;
	publisher: string;
	url: string;
	revision: string;
	publishedAt: number | null;
	retrievedAt: number;
	freshUntil: number;
	license: string;
	confidence: number;
}

export interface BenchmarkObservation {
	model: ModelIdentity;
	dimension: string;
	value: number;
	unit: MetricUnit;
	provenance: BenchmarkProvenance;
	methodology: Record<string, string | number | boolean | null | string[]>;
}

export interface BenchmarkSourceSnapshot {
	sourceId: string;
	snapshotId: string;
	retrievedAt: number;
	observations: BenchmarkObservation[];
}

export interface BenchmarkSnapshot extends BenchmarkSourceSnapshot {
	publishedAt: number;
}

export interface BenchmarkSourceStatus {
	id: string;
	ok: boolean | null;
	hasEvidence: boolean;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	observations: number;
	error?: "source refresh failed";
}

export interface BenchmarkRefreshResult {
	observedAt: number;
	sources: BenchmarkSourceStatus[];
}

export interface BenchmarkQuery {
	sourceId: string;
	model?: string;
	dimension?: string;
	limit?: number;
}

export interface BenchmarkQueryResult extends BenchmarkSnapshot {
	completeness: "complete" | "truncated";
	freshness: "fresh" | "stale";
	freshUntil: number;
}

export interface BenchmarkCatalogOptions {
	clock?: () => number;
	refreshIntervalMs?: number;
}

export type BenchmarkSource = BenchmarkSourcePort;

const VERSION_SUFFIX = /-(\d{4}-\d{2}-\d{2})$/;
const SOURCE_TYPES = new Set<BenchmarkSourceType>(["creator", "marketplace", "independent", "operational", "preference", "local"]);

function boundedText(value: unknown, name: string, maximum = BENCHMARK_MAX_TEXT_CHARACTERS): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
	const normalized = value.trim();
	if (normalized.length > maximum) throw new Error(`${name} exceeds the length limit`);
	if (/\p{Cc}/u.test(normalized)) throw new Error(`${name} contains control characters`);
	return normalized;
}

function identityPart(value: string, name: string, allowPath = false): string {
	const normalized = boundedText(value, name, BENCHMARK_IDENTITY_MAX_CHARACTERS).toLowerCase();
	const pattern = allowPath ? /^[a-z0-9][a-z0-9._:+/-]*$/ : /^[a-z0-9][a-z0-9._:+-]*$/;
	if (!pattern.test(normalized) || normalized.includes("//")) throw new Error(`${name} is invalid`);
	return normalized;
}

export function normalizeModelIdentity(provider: string, model: string, aliases: string[] = []): ModelIdentity {
	const normalizedProvider = identityPart(provider, "provider");
	const normalizedModel = identityPart(model, "model", true);
	const version = VERSION_SUFFIX.exec(normalizedModel)?.[1] ?? null;
	const canonical = `${normalizedProvider}/${normalizedModel}`;
	const normalizedAliases = [...new Set(aliases.map((alias) => boundedText(alias, "alias", BENCHMARK_IDENTITY_MAX_CHARACTERS).toLowerCase()))]
		.filter((alias) => alias !== canonical)
		.sort();
	return { provider: normalizedProvider, model: normalizedModel, version, canonical, aliases: normalizedAliases };
}

function validateIdentity(value: unknown): ModelIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("model identity is required");
	const input = value as Record<string, unknown>;
	if (!Array.isArray(input["aliases"]) || !input["aliases"].every((alias) => typeof alias === "string")) throw new Error("model aliases are invalid");
	const normalized = normalizeModelIdentity(String(input["provider"] ?? ""), String(input["model"] ?? ""), input["aliases"] as string[]);
	if (input["canonical"] !== normalized.canonical || input["version"] !== normalized.version) throw new Error("model identity is not normalized");
	return normalized;
}

function validateTimestamp(value: unknown, name: string, nullable = false): number | null {
	if (nullable && value === null) return null;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer timestamp`);
	return value as number;
}

function validateProvenance(value: unknown): BenchmarkProvenance {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("provenance is required");
	const input = value as Record<string, unknown>;
	const sourceId = identityPart(String(input["sourceId"] ?? ""), "source id");
	if (!SOURCE_TYPES.has(input["sourceType"] as BenchmarkSourceType)) throw new Error("source type is invalid");
	let url: URL;
	try { url = new URL(boundedText(input["url"], "source URL")); } catch { throw new Error("source URL is invalid"); }
	if (url.protocol !== "https:") throw new Error("source URL must use HTTPS");
	const confidence = input["confidence"];
	if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence must be between zero and one");
	const retrievedAt = validateTimestamp(input["retrievedAt"], "retrieval time") as number;
	const freshUntil = validateTimestamp(input["freshUntil"], "freshness deadline") as number;
	if (freshUntil < retrievedAt) throw new Error("freshness deadline precedes retrieval");
	return {
		sourceId,
		sourceType: input["sourceType"] as BenchmarkSourceType,
		publisher: boundedText(input["publisher"], "publisher"),
		url: url.toString(),
		revision: boundedText(input["revision"], "revision"),
		publishedAt: validateTimestamp(input["publishedAt"], "publication time", true),
		retrievedAt,
		freshUntil,
		license: boundedText(input["license"], "license"),
		confidence,
	};
}

function validateMethodology(value: unknown): BenchmarkObservation["methodology"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("methodology is required");
	const serialized = JSON.stringify(value);
	if (serialized.length > BENCHMARK_MAX_TEXT_CHARACTERS) throw new Error("methodology exceeds the size limit");
	return structuredClone(value as BenchmarkObservation["methodology"]);
}

export function validateBenchmarkObservation(value: unknown): BenchmarkObservation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("benchmark observation must be an object");
	const input = value as Record<string, unknown>;
	const numericValue = input["value"];
	if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) throw new Error("benchmark value must be finite");
	if (!METRIC_UNITS.includes(input["unit"] as MetricUnit)) throw new Error("benchmark unit is not supported");
	return {
		model: validateIdentity(input["model"]),
		dimension: identityPart(String(input["dimension"] ?? ""), "dimension"),
		value: numericValue,
		unit: input["unit"] as MetricUnit,
		provenance: validateProvenance(input["provenance"]),
		methodology: validateMethodology(input["methodology"]),
	};
}

function validateSourceSnapshot(value: BenchmarkSourceSnapshot, expectedSourceId: string): BenchmarkSourceSnapshot {
	const sourceId = identityPart(value.sourceId, "source id");
	if (sourceId !== expectedSourceId) throw new Error("source snapshot identity mismatch");
	const snapshotId = boundedText(value.snapshotId, "snapshot id", BENCHMARK_IDENTITY_MAX_CHARACTERS);
	const retrievedAt = validateTimestamp(value.retrievedAt, "retrieval time") as number;
	if (!Array.isArray(value.observations) || value.observations.length > BENCHMARK_MAX_OBSERVATIONS_PER_SNAPSHOT) throw new Error("source snapshot exceeds the observation limit");
	const observations = value.observations.map(validateBenchmarkObservation);
	if (observations.some((observation) => observation.provenance.sourceId !== sourceId || observation.provenance.retrievedAt !== retrievedAt)) {
		throw new Error("source snapshot provenance mismatch");
	}
	return { sourceId, snapshotId, retrievedAt, observations };
}

export class BenchmarkCatalog implements BenchmarkController {
	private readonly clock: () => number;
	private readonly refreshIntervalMs: number;
	private readonly states = new Map<string, BenchmarkSourceStatus>();

	constructor(
		private readonly store: BenchmarkStore,
		private readonly sources: BenchmarkSource[],
		options: BenchmarkCatalogOptions = {},
	) {
		this.clock = options.clock ?? Date.now;
		this.refreshIntervalMs = options.refreshIntervalMs ?? BENCHMARK_REFRESH_INTERVAL_MS;
		for (const source of sources) {
			const evidence = store.latest(source.id);
			this.states.set(source.id, {
				id: source.id,
				ok: null,
				hasEvidence: evidence !== null,
				lastAttemptAt: null,
				lastSuccessAt: evidence?.retrievedAt ?? null,
				observations: evidence?.observations.length ?? 0,
			});
		}
	}

	async refresh(force = false): Promise<BenchmarkRefreshResult> {
		const now = this.clock();
		await Promise.all(this.sources.map(async (source) => {
			const prior = this.states.get(source.id)!;
			if (!force && prior.lastAttemptAt !== null && now - prior.lastAttemptAt < this.refreshIntervalMs) return;
			this.states.set(source.id, { ...prior, lastAttemptAt: now });
			try {
				const snapshot = validateSourceSnapshot(await source.fetch(), source.id);
				const published = this.store.publish(snapshot.sourceId, snapshot.snapshotId, snapshot.observations);
				this.states.set(source.id, { id: source.id, ok: true, hasEvidence: true, lastAttemptAt: now, lastSuccessAt: published.retrievedAt, observations: published.observations.length });
			} catch {
				const evidence = this.store.latest(source.id);
				this.states.set(source.id, { id: source.id, ok: false, hasEvidence: evidence !== null, lastAttemptAt: now, lastSuccessAt: evidence?.retrievedAt ?? prior.lastSuccessAt, observations: evidence?.observations.length ?? prior.observations, error: "source refresh failed" });
			}
		}));
		return { observedAt: now, sources: this.status().sources };
	}

	status(): BenchmarkRefreshResult {
		return { observedAt: this.clock(), sources: this.sources.map((source) => structuredClone(this.states.get(source.id)!)) };
	}

	query(input: BenchmarkQuery): BenchmarkQueryResult {
		const sourceId = identityPart(input.sourceId, "source id");
		const snapshot = this.store.latest(sourceId);
		if (!snapshot) throw new Error("benchmark evidence is not available for the source");
		const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : BENCHMARK_DEFAULT_QUERY_LIMIT;
		const limit = Math.max(1, Math.min(BENCHMARK_MAX_QUERY_LIMIT, requestedLimit));
		const model = input.model?.trim().toLowerCase();
		const dimension = input.dimension?.trim().toLowerCase();
		const matched = snapshot.observations.filter((observation) => (!model || observation.model.canonical === model || observation.model.aliases.includes(model)) && (!dimension || observation.dimension === dimension));
		const freshUntil = Math.min(...snapshot.observations.map((observation) => observation.provenance.freshUntil));
		return {
			...structuredClone(snapshot),
			observations: structuredClone(matched.slice(0, limit)),
			completeness: matched.length > limit ? "truncated" : "complete",
			freshness: this.clock() <= freshUntil ? "fresh" : "stale",
			freshUntil,
		};
	}
}
