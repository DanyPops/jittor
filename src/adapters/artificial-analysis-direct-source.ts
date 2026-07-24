import { BENCHMARK_MAX_MODELS_PER_SOURCE, BENCHMARK_REFRESH_INTERVAL_MS, BENCHMARK_SOURCE_MAX_RESPONSE_BYTES } from "../constants.ts";
import { normalizeModelIdentity, validateBenchmarkObservation, type BenchmarkObservation, type BenchmarkSourceSnapshot } from "../domain/benchmark.ts";
import type { BenchmarkSource } from "../ports/benchmark-source.ts";
import { contractRecord } from "../providers/openrouter-contracts.ts";

const SOURCE_ID = "artificial-analysis-direct";
const ENDPOINT = "https://artificialanalysis.ai/api/v2/data/llms/models";

export type ArtificialAnalysisTransport = (request: Request) => Promise<Response>;

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new Error(`Artificial Analysis ${name} schema changed`);
	return value;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Artificial Analysis ${name} schema changed`);
	return value;
}

/** Replaces the removed OpenRouter passthrough to the same publisher; adds math_index and measured latency it never exposed. Same dimension names, since it's the same facts. */
export class ArtificialAnalysisDirectSource implements BenchmarkSource {
	readonly id = SOURCE_ID;

	constructor(
		private readonly apiKey: string,
		private readonly transport: ArtificialAnalysisTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {
		if (apiKey.length === 0) throw new Error("Artificial Analysis API key is required");
	}

	async fetch(): Promise<BenchmarkSourceSnapshot> {
		const retrievedAt = this.clock();
		if (!Number.isSafeInteger(retrievedAt) || retrievedAt <= 0) throw new Error("benchmark retrieval time is invalid");
		const response = await this.transport(new Request(ENDPOINT, { headers: { "x-api-key": this.apiKey } }));
		if (!response.ok) throw new Error(`Artificial Analysis benchmarks failed with HTTP ${response.status}`);
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > BENCHMARK_SOURCE_MAX_RESPONSE_BYTES) throw new Error("Artificial Analysis benchmark response exceeds the size limit");
		let payload: unknown;
		try { payload = JSON.parse(text); } catch { throw new Error("Artificial Analysis benchmark response is not valid JSON"); }
		const root = contractRecord(payload, "benchmark response");
		if (!Array.isArray(root["data"]) || root["data"].length > BENCHMARK_MAX_MODELS_PER_SOURCE) throw new Error("Artificial Analysis benchmark result count is invalid");
		const revision = String(retrievedAt);
		const observations = root["data"].flatMap((value): BenchmarkObservation[] => {
			const row = contractRecord(value, "benchmark row");
			const creator = contractRecord(row["model_creator"], "model creator");
			const evaluations = contractRecord(row["evaluations"], "evaluations");
			const identity = normalizeModelIdentity(requiredText(creator["slug"], "creator slug"), requiredText(row["slug"], "model slug"), [`artificial-analysis/${requiredText(row["id"], "model id")}`]);
			const provenance = {
				sourceId: SOURCE_ID,
				sourceType: "creator" as const,
				publisher: "Artificial Analysis",
				url: "https://artificialanalysis.ai/",
				revision,
				publishedAt: retrievedAt,
				retrievedAt,
				freshUntil: retrievedAt + BENCHMARK_REFRESH_INTERVAL_MS,
				license: "Attribution to artificialanalysis.ai required; see their free API terms",
				confidence: 0.85,
			};
			const methodology = { basis: "Artificial Analysis direct API, /data/llms/models" };
			const observations: BenchmarkObservation[] = [];
			const index = (field: string, dimension: string): void => {
				const raw = evaluations[field];
				if (raw === undefined || raw === null) return;
				observations.push(validateBenchmarkObservation({ model: identity, dimension, value: requiredNumber(raw, field), unit: "ratio", provenance, methodology }));
			};
			index("artificial_analysis_coding_index", "quality-coding");
			index("artificial_analysis_intelligence_index", "quality-general");
			index("artificial_analysis_math_index", "quality-math");
			const ttft = row["median_time_to_first_token_seconds"];
			if (typeof ttft === "number" && Number.isFinite(ttft)) {
				observations.push(validateBenchmarkObservation({ model: identity, dimension: "latency", value: ttft * 1_000, unit: "milliseconds", provenance, methodology }));
			}
			return observations;
		});
		return { sourceId: this.id, snapshotId: `${this.id}:${revision}`, retrievedAt, observations };
	}
}
