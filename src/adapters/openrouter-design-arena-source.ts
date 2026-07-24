import {
	BENCHMARK_MAX_MODELS_PER_SOURCE,
	BENCHMARK_REFRESH_INTERVAL_MS,
	BENCHMARK_SOURCE_MAX_RESPONSE_BYTES,
} from "../constants.ts";
import { normalizeModelIdentity, validateBenchmarkObservation, type BenchmarkObservation, type BenchmarkSourceSnapshot } from "../domain/benchmark.ts";
import type { BenchmarkSource } from "../ports/benchmark-source.ts";
import { contractRecord } from "../providers/openrouter-contracts.ts";
import type { OpenRouterBenchmarkTransport } from "./openrouter-benchmark-source.ts";

const SOURCE_ID = "openrouter-design-arena";
const BASE_URL = `https://openrouter.ai/api/v1/benchmarks?source=design-arena&max_results=${BENCHMARK_MAX_MODELS_PER_SOURCE}`;

/**
 * Design Arena publishes rankings across dozens of arena/category pairs (music, video, TTS,
 * ASCII art, ...) -- most of them have nothing to do with a text coding agent's model choice.
 * This is a deliberate, bounded allowlist of the categories that measure frontend/UI-generation
 * skill, the one facet of "design" quality relevant to routing a coding agent. Extending this
 * list is a data curation decision (does the category's skill actually predict something a
 * coding agent needs), not a mechanical one.
 */
const RELEVANT_CATEGORIES = ["codecategories", "website", "uicomponent", "dataviz", "svg"] as const;

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new Error(`OpenRouter Design Arena benchmark ${name} schema changed`);
	return value;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`OpenRouter Design Arena benchmark ${name} schema changed`);
	return value;
}

function identityFromOpenRouterId(openRouterId: string): { provider: string; model: string } {
	const separator = openRouterId.indexOf("/");
	if (separator <= 0 || separator === openRouterId.length - 1) throw new Error("OpenRouter Design Arena model identity schema changed");
	return { provider: openRouterId.slice(0, separator), model: openRouterId.slice(separator + 1) };
}

export class OpenRouterDesignArenaSource implements BenchmarkSource {
	readonly id = SOURCE_ID;

	constructor(
		private readonly apiKey: string,
		private readonly transport: OpenRouterBenchmarkTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {
		if (apiKey.length === 0) throw new Error("OpenRouter API key is required for Design Arena benchmark evidence");
	}

	async fetch(): Promise<BenchmarkSourceSnapshot> {
		const retrievedAt = this.clock();
		if (!Number.isSafeInteger(retrievedAt) || retrievedAt <= 0) throw new Error("benchmark retrieval time is invalid");
		const perCategory = await Promise.all(RELEVANT_CATEGORIES.map((category) => this.fetchCategory(category, retrievedAt)));
		const revisions = new Set(perCategory.map((page) => page.revision));
		const observations = perCategory.flatMap((page) => page.observations);
		return { sourceId: this.id, snapshotId: `${this.id}:${[...revisions].sort().join(",")}`, retrievedAt, observations };
	}

	private async fetchCategory(category: string, retrievedAt: number): Promise<{ revision: string; observations: BenchmarkObservation[] }> {
		const url = `${BASE_URL}&task_type=${category}`;
		const response = await this.transport(new Request(url, { headers: { authorization: `Bearer ${this.apiKey}` } }));
		if (!response.ok) throw new Error(`OpenRouter Design Arena benchmarks failed with HTTP ${response.status}`);
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > BENCHMARK_SOURCE_MAX_RESPONSE_BYTES) throw new Error("OpenRouter Design Arena benchmark response exceeds the size limit");
		let payload: unknown;
		try { payload = JSON.parse(text); } catch { throw new Error("OpenRouter Design Arena benchmark response is not valid JSON"); }
		const root = contractRecord(payload, "benchmark response");
		const meta = contractRecord(root["meta"], "benchmark metadata");
		if (!Array.isArray(root["data"]) || root["data"].length > BENCHMARK_MAX_MODELS_PER_SOURCE) throw new Error("OpenRouter Design Arena benchmark result count is invalid");
		if (requiredText(meta["source"], "source") !== "design-arena") throw new Error("OpenRouter Design Arena benchmark source schema changed");
		const asOf = requiredText(meta["as_of"], "as-of date");
		const publishedAt = Date.parse(asOf);
		if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) throw new Error("OpenRouter Design Arena benchmark publication date schema changed");
		const revision = `${category}:${asOf}`;
		const observations = root["data"].flatMap((value): BenchmarkObservation[] => {
			const row = contractRecord(value, "benchmark row");
			if (requiredText(row["source"], "row source") !== "design-arena") throw new Error("OpenRouter Design Arena benchmark row source schema changed");
			// A null open_router_id means the model isn't reachable through OpenRouter at all
			// (proprietary platform, image/video generator, deprecated model) -- not evidence
			// Jittor can ever route against, so the row is skipped rather than rejected.
			const openRouterId = row["open_router_id"];
			if (openRouterId === null) return [];
			const { provider, model } = identityFromOpenRouterId(requiredText(openRouterId, "open_router_id"));
			const identity = normalizeModelIdentity(provider, model, [`openrouter/${provider}/${model}`]);
			const provenance = {
				sourceId: SOURCE_ID,
				sourceType: "independent" as const,
				publisher: "Design Arena via OpenRouter",
				url: BASE_URL,
				revision,
				publishedAt,
				retrievedAt,
				freshUntil: retrievedAt + BENCHMARK_REFRESH_INTERVAL_MS,
				license: "OpenRouter API terms; Design Arena terms apply",
				confidence: 0.7,
			};
			const methodology = { basis: "Design Arena Elo rating via OpenRouter", category, asOf };
			return [validateBenchmarkObservation({
				model: identity, dimension: "quality-design", value: requiredNumber(row["elo"], "elo rating"), unit: "elo", provenance, methodology,
			})];
		});
		return { revision, observations };
	}
}
