import {
	BENCHMARK_MAX_MODELS_PER_SOURCE,
	BENCHMARK_REFRESH_INTERVAL_MS,
	BENCHMARK_SOURCE_MAX_RESPONSE_BYTES,
} from "../constants.ts";
import { normalizeModelIdentity, validateBenchmarkObservation, type BenchmarkObservation, type BenchmarkSourceSnapshot } from "../domain/benchmark.ts";
import type { BenchmarkSource } from "../ports/benchmark-source.ts";
import { contractRecord } from "../providers/openrouter-contracts.ts";
import type { OpenRouterBenchmarkTransport } from "./openrouter-benchmark-source.ts";

const SOURCE_ID = "openrouter-artificial-analysis";
const ENDPOINT = `https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding&max_results=${BENCHMARK_MAX_MODELS_PER_SOURCE}`;

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new Error(`OpenRouter benchmark ${name} schema changed`);
	return value;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`OpenRouter benchmark ${name} schema changed`);
	return value;
}

function price(value: unknown, name: string): number {
	const parsed = Number(requiredText(value, name));
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`OpenRouter benchmark ${name} schema changed`);
	return parsed;
}

export class OpenRouterBenchmarkIndexSource implements BenchmarkSource {
	readonly id = SOURCE_ID;

	constructor(
		private readonly apiKey: string,
		private readonly transport: OpenRouterBenchmarkTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {
		if (apiKey.length === 0) throw new Error("OpenRouter API key is required for benchmark indices");
	}

	async fetch(): Promise<BenchmarkSourceSnapshot> {
		const response = await this.transport(new Request(ENDPOINT, { headers: { authorization: `Bearer ${this.apiKey}` } }));
		if (!response.ok) throw new Error(`OpenRouter benchmarks failed with HTTP ${response.status}`);
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > BENCHMARK_SOURCE_MAX_RESPONSE_BYTES) throw new Error("OpenRouter benchmark response exceeds the size limit");
		let payload: unknown;
		try { payload = JSON.parse(text); } catch { throw new Error("OpenRouter benchmark response is not valid JSON"); }
		const root = contractRecord(payload, "benchmark response");
		const meta = contractRecord(root["meta"], "benchmark metadata");
		if (!Array.isArray(root["data"]) || root["data"].length === 0 || root["data"].length > BENCHMARK_MAX_MODELS_PER_SOURCE) throw new Error("OpenRouter benchmark result count is invalid");
		if (requiredText(meta["source"], "source") !== "artificial-analysis") throw new Error("OpenRouter benchmark source schema changed");
		const version = requiredText(meta["version"], "version");
		const asOf = requiredText(meta["as_of"], "as-of date");
		const publishedAt = Date.parse(asOf);
		if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) throw new Error("OpenRouter benchmark publication date schema changed");
		const upstreamUrl = new URL(requiredText(meta["source_url"], "source URL"));
		if (upstreamUrl.protocol !== "https:") throw new Error("OpenRouter benchmark source URL must use HTTPS");
		const retrievedAt = this.clock();
		if (!Number.isSafeInteger(retrievedAt) || retrievedAt <= 0) throw new Error("benchmark retrieval time is invalid");
		const revision = `${version}:${asOf}`;
		const observations = root["data"].flatMap((value): BenchmarkObservation[] => {
			const row = contractRecord(value, "benchmark row");
			if (requiredText(row["source"], "row source") !== "artificial-analysis") throw new Error("OpenRouter benchmark row source schema changed");
			const permaslug = requiredText(row["model_permaslug"], "model permaslug");
			const separator = permaslug.indexOf("/");
			if (separator <= 0 || separator === permaslug.length - 1) throw new Error("OpenRouter benchmark model identity schema changed");
			const model = normalizeModelIdentity(permaslug.slice(0, separator), permaslug.slice(separator + 1), [`openrouter/${permaslug}`]);
			const pricing = contractRecord(row["pricing"], "benchmark pricing");
			const provenance = {
				sourceId: SOURCE_ID,
				sourceType: "independent" as const,
				publisher: "Artificial Analysis via OpenRouter",
				url: ENDPOINT,
				revision,
				publishedAt,
				retrievedAt,
				freshUntil: retrievedAt + BENCHMARK_REFRESH_INTERVAL_MS,
				license: "OpenRouter API terms; upstream terms apply",
				confidence: 0.8,
			};
			const common = { model, provenance };
			const methodology = { basis: "Artificial Analysis index via OpenRouter", upstreamUrl: upstreamUrl.toString(), version, asOf };
			return [
				validateBenchmarkObservation({ ...common, dimension: "quality-coding", value: requiredNumber(row["coding_index"], "coding index"), unit: "ratio", methodology }),
				validateBenchmarkObservation({ ...common, dimension: "quality-general", value: requiredNumber(row["intelligence_index"], "intelligence index"), unit: "ratio", methodology }),
				// agentic_index measures tool-use/agentic execution style, an activity (type), not a subject-matter domain.
				validateBenchmarkObservation({ ...common, dimension: "quality-type-planning", value: requiredNumber(row["agentic_index"], "agentic index"), unit: "ratio", methodology }),
				validateBenchmarkObservation({ ...common, dimension: "price-input", value: price(pricing["prompt"], "prompt pricing"), unit: "usd", methodology: { ...methodology, basis: "OpenRouter USD per input token" } }),
				validateBenchmarkObservation({ ...common, dimension: "price-output", value: price(pricing["completion"], "completion pricing"), unit: "usd", methodology: { ...methodology, basis: "OpenRouter USD per output token" } }),
			];
		});
		return { sourceId: this.id, snapshotId: `${this.id}:${revision}`, retrievedAt, observations };
	}
}
