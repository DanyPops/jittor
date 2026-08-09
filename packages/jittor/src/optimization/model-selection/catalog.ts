import {
	MODEL_CATALOG_DEFAULT_QUERY_LIMIT,
	MODEL_CATALOG_FRESHNESS_MS,
	MODEL_CATALOG_MAX_ENTRIES,
	MODEL_CATALOG_MAX_QUERY_LIMIT,
	MODEL_CATALOG_MAX_RESPONSE_BYTES,
	MODEL_CATALOG_REQUEST_TIMEOUT_MS,
} from "../../constants.ts";

export type ModelCatalogAuthority = "models-dev-provider" | "user-override";
export type ModelModality = "text" | "audio" | "image" | "video" | "pdf";

export interface ModelCatalogProvenance {
	sourceId: "models.dev";
	sourceUrl: string;
	revision: string;
	retrievedAt: number;
	freshUntil: number;
	license: "MIT";
}

export interface ModelCatalogFieldAuthority {
	authority: ModelCatalogAuthority;
	sourceId: "models.dev" | "local-configuration";
	revision: string;
	retrievedAt: number;
}

export interface ModelCatalogPriceTier {
	contextSize: number;
	input: number;
	output: number;
	reasoning?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelCatalogPricing {
	input?: number;
	output?: number;
	reasoning?: number;
	cacheRead?: number;
	cacheWrite?: number;
	contextOver200k?: Omit<ModelCatalogPricing, "contextOver200k" | "tiers">;
	tiers?: ModelCatalogPriceTier[];
}

export interface ModelCatalogEntry {
	provider: string;
	model: string;
	canonical: string;
	aliases: string[];
	name: string;
	status: "active" | "alpha" | "beta" | "deprecated";
	capabilities: { attachment: boolean; reasoning: boolean; toolCall: boolean; structuredOutput: boolean };
	modalities: { input: ModelModality[]; output: ModelModality[] };
	limits: { context: number; input?: number; output: number };
	pricing?: ModelCatalogPricing;
	fieldAuthority: Record<string, ModelCatalogFieldAuthority>;
}

export interface ModelCatalogSnapshot {
	snapshotId: string;
	provenance: ModelCatalogProvenance;
	entries: ModelCatalogEntry[];
}

export interface ModelCatalogStore {
	publish(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot;
	latest(): ModelCatalogSnapshot | null;
}

export interface ModelCatalogSource {
	readonly id: "models.dev";
	fetch(): Promise<ModelCatalogSnapshot>;
}

export interface ModelCatalogStatus {
	configured: boolean;
	ok: boolean | null;
	hasSnapshot: boolean;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	entries: number;
	revision: string | null;
	error?: "catalog refresh failed";
}

export interface ModelCatalogOverrides {
	contextTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	inputPrice?: number;
	outputPrice?: number;
}

export interface ModelCatalogQuery {
	provider?: string;
	model?: string;
	limit?: number;
	overrides?: ModelCatalogOverrides;
}

export interface ModelCatalogQueryResult {
	snapshotId: string;
	provenance: ModelCatalogProvenance;
	freshness: "fresh" | "stale";
	completeness: "complete" | "truncated";
	entries: ModelCatalogEntry[];
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 200): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
	const result = value.trim();
	if (result.length > max || /\p{Cc}/u.test(result)) throw new Error(`${name} is invalid`);
	return result;
}

function identity(value: unknown, name: string): string {
	const result = text(value, name).toLowerCase();
	if (!/^[a-z0-9@~][a-z0-9@~._:+/-]*$/.test(result) || result.includes("//")) throw new Error(`${name} is invalid`);
	return result;
}

function nonnegative(value: unknown, name: string, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
		throw new Error(`${name} must be a non-negative ${integer ? "integer" : "number"}`);
	return value;
}

function optionalNumber(value: unknown, name: string, integer = false): number | undefined {
	return value === undefined ? undefined : nonnegative(value, name, integer);
}

const MODALITIES = new Set<ModelModality>(["text", "audio", "image", "video", "pdf"]);
function modalities(value: unknown, name: string): ModelModality[] {
	if (!Array.isArray(value) || !value.every((item) => MODALITIES.has(item as ModelModality))) throw new Error(`${name} is invalid`);
	return [...new Set(value as ModelModality[])];
}

function optionalBoolean(value: unknown, name: string, fallback = false): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
	return value;
}

function pricing(value: unknown, path: string): ModelCatalogPricing | undefined {
	if (value === undefined) return undefined;
	const input = record(value, path);
	const result: ModelCatalogPricing = {
		input: nonnegative(input.input, `${path}.input`),
		output: nonnegative(input.output, `${path}.output`),
	};
	const reasoning = optionalNumber(input.reasoning, `${path}.reasoning`);
	const cacheRead = optionalNumber(input.cache_read, `${path}.cache_read`);
	const cacheWrite = optionalNumber(input.cache_write, `${path}.cache_write`);
	if (reasoning !== undefined) result.reasoning = reasoning;
	if (cacheRead !== undefined) result.cacheRead = cacheRead;
	if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
	if (input.context_over_200k !== undefined) {
		const over = pricing(input.context_over_200k, `${path}.context_over_200k`)!;
		delete over.contextOver200k;
		delete over.tiers;
		result.contextOver200k = over;
	}
	if (input.tiers !== undefined) {
		if (!Array.isArray(input.tiers)) throw new Error(`${path}.tiers must be an array`);
		result.tiers = input.tiers.map((value, index) => {
			const tier = record(value, `${path}.tiers[${index}]`);
			const definition = record(tier.tier, `${path}.tiers[${index}].tier`);
			if (definition.type !== undefined && definition.type !== "context") throw new Error(`${path}.tiers[${index}].tier.type is invalid`);
			const translated: ModelCatalogPriceTier = {
				contextSize: nonnegative(definition.size, `${path}.tiers[${index}].tier.size`, true),
				input: nonnegative(tier.input, `${path}.tiers[${index}].input`),
				output: nonnegative(tier.output, `${path}.tiers[${index}].output`),
			};
			const tierReasoning = optionalNumber(tier.reasoning, `${path}.tiers[${index}].reasoning`);
			const tierRead = optionalNumber(tier.cache_read, `${path}.tiers[${index}].cache_read`);
			const tierWrite = optionalNumber(tier.cache_write, `${path}.tiers[${index}].cache_write`);
			if (tierReasoning !== undefined) translated.reasoning = tierReasoning;
			if (tierRead !== undefined) translated.cacheRead = tierRead;
			if (tierWrite !== undefined) translated.cacheWrite = tierWrite;
			return translated;
		});
	}
	return result;
}

function authority(provenance: ModelCatalogProvenance): ModelCatalogFieldAuthority {
	return {
		authority: "models-dev-provider",
		sourceId: "models.dev",
		revision: provenance.revision,
		retrievedAt: provenance.retrievedAt,
	};
}

function fieldAuthorities(
	entry: Omit<ModelCatalogEntry, "fieldAuthority">,
	provenance: ModelCatalogProvenance,
): Record<string, ModelCatalogFieldAuthority> {
	const fields = [
		"status",
		"limits.context",
		"limits.output",
		"capabilities.attachment",
		"capabilities.reasoning",
		"capabilities.toolCall",
		"capabilities.structuredOutput",
		"modalities.input",
		"modalities.output",
	];
	if (entry.limits.input !== undefined) fields.push("limits.input");
	if (entry.pricing) {
		for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
			if (entry.pricing[key] !== undefined) fields.push(`pricing.${key}`);
		}
		if (entry.pricing.contextOver200k) fields.push("pricing.contextOver200k");
		if (entry.pricing.tiers) fields.push("pricing.tiers");
	}
	return Object.fromEntries(fields.map((field) => [field, authority(provenance)]));
}

export function translateModelsDevCatalog(
	value: unknown,
	input: Omit<ModelCatalogProvenance, "sourceId" | "license">,
): ModelCatalogSnapshot {
	const sourceUrl = new URL(input.sourceUrl);
	if (sourceUrl.protocol !== "https:" && sourceUrl.hostname !== "127.0.0.1" && sourceUrl.hostname !== "localhost")
		throw new Error("catalog source URL must use HTTPS or loopback HTTP");
	if (!Number.isSafeInteger(input.retrievedAt) || input.retrievedAt <= 0) throw new Error("catalog retrieval time is invalid");
	if (!Number.isSafeInteger(input.freshUntil) || input.freshUntil < input.retrievedAt)
		throw new Error("catalog freshness deadline is invalid");
	const provenance: ModelCatalogProvenance = { sourceId: "models.dev", license: "MIT", ...input, sourceUrl: sourceUrl.toString() };
	const providers = record(value, "models.dev catalog");
	const entries: ModelCatalogEntry[] = [];
	for (const [providerKey, providerValue] of Object.entries(providers)) {
		const provider = record(providerValue, `provider ${providerKey}`);
		const providerId = identity(provider.id ?? providerKey, `provider ${providerKey}.id`);
		if (providerId !== identity(providerKey, "provider key")) throw new Error(`provider ${providerKey} identity mismatch`);
		const models = record(provider.models, `provider ${providerKey}.models`);
		for (const [modelKey, modelValue] of Object.entries(models)) {
			if (entries.length >= MODEL_CATALOG_MAX_ENTRIES) throw new Error("models.dev catalog exceeds the entry limit");
			const path = `provider ${providerKey}.models.${modelKey}`;
			const model = record(modelValue, path);
			const modelId = identity(modelKey, `${path}.key`);
			const reportedId = identity(model.id ?? modelKey, `${path}.id`);
			const limit = record(model.limit, `${path}.limit`);
			const modality = record(model.modalities, `${path}.modalities`);
			const rawStatus = model.status ?? "active";
			if (rawStatus !== "active" && rawStatus !== "alpha" && rawStatus !== "beta" && rawStatus !== "deprecated")
				throw new Error(`${path}.status is invalid`);
			const base: Omit<ModelCatalogEntry, "fieldAuthority"> = {
				provider: providerId,
				model: modelId,
				canonical: `${providerId}/${modelId}`,
				aliases: reportedId === modelId ? [] : [reportedId],
				name: text(model.name, `${path}.name`),
				status: rawStatus,
				capabilities: {
					attachment: optionalBoolean(model.attachment, `${path}.attachment`),
					reasoning: optionalBoolean(model.reasoning, `${path}.reasoning`),
					toolCall: optionalBoolean(model.tool_call, `${path}.tool_call`),
					structuredOutput: optionalBoolean(model.structured_output, `${path}.structured_output`),
				},
				modalities: {
					input: modalities(modality.input, `${path}.modalities.input`),
					output: modalities(modality.output, `${path}.modalities.output`),
				},
				limits: {
					context: nonnegative(limit.context, `${path}.limit.context`, true),
					...(limit.input === undefined ? {} : { input: nonnegative(limit.input, `${path}.limit.input`, true) }),
					output: nonnegative(limit.output, `${path}.limit.output`, true),
				},
				...(model.cost === undefined ? {} : { pricing: pricing(model.cost, `${path}.cost`) }),
			};
			entries.push({ ...base, fieldAuthority: fieldAuthorities(base, provenance) });
		}
	}
	if (entries.length === 0) throw new Error("models.dev catalog contains no models");
	return { snapshotId: input.revision, provenance, entries };
}

async function digestRevision(body: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type ModelCatalogTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelsDevCatalogSourceOptions {
	sourceUrl?: string;
	transport?: ModelCatalogTransport;
	clock?: () => number;
	timeoutMs?: number;
	maxResponseBytes?: number;
	freshnessMs?: number;
}

export class ModelsDevCatalogSource implements ModelCatalogSource {
	readonly id = "models.dev" as const;
	private readonly sourceUrl: string;
	private readonly transport: ModelCatalogTransport;
	private readonly clock: () => number;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;
	private readonly freshnessMs: number;

	constructor(options: ModelsDevCatalogSourceOptions = {}) {
		this.sourceUrl = options.sourceUrl ?? "https://models.dev/api.json";
		this.transport = options.transport ?? fetch;
		this.clock = options.clock ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? MODEL_CATALOG_REQUEST_TIMEOUT_MS;
		this.maxResponseBytes = options.maxResponseBytes ?? MODEL_CATALOG_MAX_RESPONSE_BYTES;
		this.freshnessMs = options.freshnessMs ?? MODEL_CATALOG_FRESHNESS_MS;
	}

	async fetch(): Promise<ModelCatalogSnapshot> {
		const url = new URL(this.sourceUrl);
		if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
			throw new Error("catalog source URL must use HTTPS or loopback HTTP");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.transport(url, { signal: controller.signal, headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`models.dev request failed (${response.status})`);
			const length = Number(response.headers.get("content-length") ?? 0);
			if (Number.isFinite(length) && length > this.maxResponseBytes) throw new Error("models.dev response exceeds the byte limit");
			const body = await response.text();
			if (new TextEncoder().encode(body).byteLength > this.maxResponseBytes) throw new Error("models.dev response exceeds the byte limit");
			const retrievedAt = this.clock();
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				throw new Error("models.dev response is not valid JSON");
			}
			return translateModelsDevCatalog(parsed, {
				sourceUrl: url.toString(),
				retrievedAt,
				freshUntil: retrievedAt + this.freshnessMs,
				revision: await digestRevision(body),
			});
		} finally {
			clearTimeout(timeout);
		}
	}
}

function localAuthority(now: number): ModelCatalogFieldAuthority {
	return { authority: "user-override", sourceId: "local-configuration", revision: "runtime", retrievedAt: now };
}

function applyOverrides(entry: ModelCatalogEntry, overrides: ModelCatalogOverrides | undefined, now: number): ModelCatalogEntry {
	if (!overrides) return entry;
	const result = structuredClone(entry);
	const values: Array<[keyof ModelCatalogOverrides, string, (value: number) => void]> = [
		["contextTokens", "limits.context", (value) => (result.limits.context = value)],
		["inputTokens", "limits.input", (value) => (result.limits.input = value)],
		["outputTokens", "limits.output", (value) => (result.limits.output = value)],
		[
			"inputPrice",
			"pricing.input",
			(value) => {
				if (!result.pricing) result.pricing = {};
				result.pricing.input = value;
			},
		],
		[
			"outputPrice",
			"pricing.output",
			(value) => {
				if (!result.pricing) result.pricing = {};
				result.pricing.output = value;
			},
		],
	];
	for (const [key, field, assign] of values) {
		const value = overrides[key];
		if (value === undefined) continue;
		nonnegative(value, `override ${key}`, key.endsWith("Tokens"));
		assign(value);
		result.fieldAuthority[field] = localAuthority(now);
	}
	return result;
}

export interface ModelCatalogController {
	refresh(force?: boolean): Promise<ModelCatalogStatus>;
	status(): ModelCatalogStatus;
	query(input?: ModelCatalogQuery): ModelCatalogQueryResult;
}

export class ModelCatalog implements ModelCatalogController {
	private readonly clock: () => number;
	private state: ModelCatalogStatus;

	constructor(
		private readonly store: ModelCatalogStore,
		private readonly source?: ModelCatalogSource,
		options: { clock?: () => number } = {},
	) {
		this.clock = options.clock ?? Date.now;
		const latest = store.latest();
		this.state = {
			configured: source !== undefined,
			ok: null,
			hasSnapshot: latest !== null,
			lastAttemptAt: null,
			lastSuccessAt: latest?.provenance.retrievedAt ?? null,
			entries: latest?.entries.length ?? 0,
			revision: latest?.provenance.revision ?? null,
		};
	}

	async refresh(force = false): Promise<ModelCatalogStatus> {
		const attemptedAt = this.clock();
		if (!this.source) return structuredClone(this.state);
		const latestBeforeRefresh = this.store.latest();
		if (!force && latestBeforeRefresh && attemptedAt <= latestBeforeRefresh.provenance.freshUntil) return structuredClone(this.state);
		try {
			const snapshot = this.store.publish(await this.source.fetch());
			this.state = {
				configured: true,
				ok: true,
				hasSnapshot: true,
				lastAttemptAt: attemptedAt,
				lastSuccessAt: snapshot.provenance.retrievedAt,
				entries: snapshot.entries.length,
				revision: snapshot.provenance.revision,
			};
		} catch {
			const latest = this.store.latest();
			this.state = {
				...this.state,
				configured: true,
				ok: false,
				hasSnapshot: latest !== null,
				lastAttemptAt: attemptedAt,
				entries: latest?.entries.length ?? this.state.entries,
				revision: latest?.provenance.revision ?? this.state.revision,
				error: "catalog refresh failed",
			};
		}
		return structuredClone(this.state);
	}

	status(): ModelCatalogStatus {
		return structuredClone(this.state);
	}

	query(input: ModelCatalogQuery = {}): ModelCatalogQueryResult {
		const snapshot = this.store.latest();
		if (!snapshot) throw new Error("model catalog is not available");
		const provider = input.provider?.trim().toLowerCase();
		const model = input.model?.trim().toLowerCase();
		const matched = snapshot.entries.filter(
			(entry) =>
				(!provider || entry.provider === provider) &&
				(!model || entry.model === model || entry.canonical === model || entry.aliases.includes(model)),
		);
		const requested = Number.isSafeInteger(input.limit) ? input.limit! : MODEL_CATALOG_DEFAULT_QUERY_LIMIT;
		const limit = Math.max(1, Math.min(MODEL_CATALOG_MAX_QUERY_LIMIT, requested));
		const now = this.clock();
		return {
			snapshotId: snapshot.snapshotId,
			provenance: structuredClone(snapshot.provenance),
			freshness: now <= snapshot.provenance.freshUntil ? "fresh" : "stale",
			completeness: matched.length > limit ? "truncated" : "complete",
			entries: matched.slice(0, limit).map((entry) => applyOverrides(structuredClone(entry), input.overrides, now)),
		};
	}
}
