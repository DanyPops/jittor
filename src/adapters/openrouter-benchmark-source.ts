import {
	BENCHMARK_MAX_MODELS_PER_SOURCE,
	BENCHMARK_REFRESH_INTERVAL_MS,
	BENCHMARK_SOURCE_MAX_RESPONSE_BYTES,
	BENCHMARK_SOURCE_MAX_TOTAL_RESPONSE_BYTES,
} from "../constants.ts";
import { normalizeModelIdentity, validateBenchmarkObservation, type BenchmarkObservation, type BenchmarkSourceSnapshot } from "../domain/benchmark.ts";
import type { BenchmarkSource } from "../ports/benchmark-source.ts";
import { contractRecord, parseOpenRouterModels, type OpenRouterModel } from "../providers/openrouter-contracts.ts";

const OPENROUTER_MODELS_BASE_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_MODELS_URL = `${OPENROUTER_MODELS_BASE_URL}?limit=${BENCHMARK_MAX_MODELS_PER_SOURCE}`;
const OPENROUTER_LATENCY_URL = `${OPENROUTER_MODELS_URL}&sort=latency-low-to-high`;
const OPENROUTER_THROUGHPUT_URL = `${OPENROUTER_MODELS_URL}&sort=throughput-high-to-low`;
const SOURCE_ID = "openrouter-models";

export type OpenRouterBenchmarkTransport = (request: Request) => Promise<Response>;

function identity(model: OpenRouterModel) {
	const separator = model.id.indexOf("/");
	if (separator <= 0 || separator === model.id.length - 1) throw new Error("OpenRouter model identity schema changed");
	const provider = model.id.slice(0, separator);
	const modelId = model.id.slice(separator + 1);
	const aliases = [`openrouter/${model.id}`, ...(model.canonicalSlug === model.id ? [] : [model.canonicalSlug])];
	return normalizeModelIdentity(provider, modelId, aliases);
}

function provenance(retrievedAt: number, revision: string, url: string, confidence: number) {
	return {
		sourceId: SOURCE_ID,
		sourceType: "marketplace" as const,
		publisher: "OpenRouter",
		url,
		revision,
		publishedAt: null,
		retrievedAt,
		freshUntil: retrievedAt + BENCHMARK_REFRESH_INTERVAL_MS,
		license: "OpenRouter API terms",
		confidence,
	};
}

function modelObservations(model: OpenRouterModel, retrievedAt: number, revision: string): BenchmarkObservation[] {
	const common = { model: identity(model), provenance: provenance(retrievedAt, revision, OPENROUTER_MODELS_URL, 0.9) };
	return [
		validateBenchmarkObservation({ ...common, dimension: "context-window", value: model.contextLength, unit: "tokens", methodology: { basis: "OpenRouter model context_length" } }),
		...(model.maxCompletionTokens === null ? [] : [validateBenchmarkObservation({ ...common, dimension: "max-output", value: model.maxCompletionTokens, unit: "tokens", methodology: { basis: "OpenRouter top_provider max_completion_tokens" } })]),
		validateBenchmarkObservation({ ...common, dimension: "price-input", value: model.pricing.prompt, unit: "usd", methodology: { basis: "USD per input token" } }),
		validateBenchmarkObservation({ ...common, dimension: "price-output", value: model.pricing.completion, unit: "usd", methodology: { basis: "USD per output token" } }),
		validateBenchmarkObservation({ ...common, dimension: "parameter-count", value: model.supportedParameters.length, unit: "count", methodology: { basis: "OpenRouter supported_parameters", parameters: [...model.supportedParameters].sort() } }),
	];
}

function rankObservations(models: OpenRouterModel[], dimension: "latency-rank" | "throughput-rank", retrievedAt: number, revision: string, url: string): BenchmarkObservation[] {
	return models.map((model, index) => validateBenchmarkObservation({
		model: identity(model),
		dimension,
		value: index + 1,
		unit: "count",
		provenance: provenance(retrievedAt, revision, url, 0.7),
		methodology: { basis: dimension === "latency-rank" ? "OpenRouter p50 TTFT server-side ordering" : "OpenRouter p50 throughput server-side ordering", rank: index + 1 },
	}));
}

interface ModelResponse {
	models: OpenRouterModel[];
	etag: string | null;
	bytes: number;
}

export class OpenRouterBenchmarkSource implements BenchmarkSource {
	readonly id = SOURCE_ID;

	constructor(
		private readonly transport: OpenRouterBenchmarkTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {}

	private async readModels(url: string): Promise<ModelResponse> {
		const response = await this.transport(new Request(url));
		if (!response.ok) throw new Error(`OpenRouter models failed with HTTP ${response.status}`);
		const text = await response.text();
		const bytes = new TextEncoder().encode(text).byteLength;
		if (bytes > BENCHMARK_SOURCE_MAX_RESPONSE_BYTES) throw new Error("OpenRouter models response exceeds the size limit");
		let payload: unknown;
		try { payload = JSON.parse(text); } catch { throw new Error("OpenRouter models response is not valid JSON"); }
		const root = contractRecord(payload, "models response");
		if (!Array.isArray(root["data"]) || root["data"].length === 0 || root["data"].length > BENCHMARK_MAX_MODELS_PER_SOURCE) throw new Error("OpenRouter models response exceeds the model limit");
		return { models: parseOpenRouterModels(payload), etag: response.headers.get("etag")?.slice(0, 120) ?? null, bytes };
	}

	async fetch(): Promise<BenchmarkSourceSnapshot> {
		const [catalog, latency, throughput] = await Promise.all([
			this.readModels(OPENROUTER_MODELS_URL),
			this.readModels(OPENROUTER_LATENCY_URL),
			this.readModels(OPENROUTER_THROUGHPUT_URL),
		]);
		if (catalog.bytes + latency.bytes + throughput.bytes > BENCHMARK_SOURCE_MAX_TOTAL_RESPONSE_BYTES) throw new Error("OpenRouter model evidence exceeds the total size limit");
		const retrievedAt = this.clock();
		if (!Number.isSafeInteger(retrievedAt) || retrievedAt <= 0) throw new Error("benchmark retrieval time is invalid");
		const revision = catalog.etag || latency.etag || throughput.etag || `retrieved:${retrievedAt}`;
		const observations = [
			...catalog.models.flatMap((model) => modelObservations(model, retrievedAt, revision)),
			...rankObservations(latency.models, "latency-rank", retrievedAt, revision, OPENROUTER_LATENCY_URL),
			...rankObservations(throughput.models, "throughput-rank", retrievedAt, revision, OPENROUTER_THROUGHPUT_URL),
		];
		return { sourceId: this.id, snapshotId: `${this.id}:${revision}`, retrievedAt, observations };
	}
}
