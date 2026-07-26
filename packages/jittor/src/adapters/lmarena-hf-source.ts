import { BENCHMARK_MAX_MODELS_PER_SOURCE, BENCHMARK_REFRESH_INTERVAL_MS, BENCHMARK_SOURCE_MAX_RESPONSE_BYTES } from "../constants.ts";
import { normalizeModelIdentity, validateBenchmarkObservation, type BenchmarkObservation, type BenchmarkSourceSnapshot } from "../domain/benchmark.ts";
import type { BenchmarkSource } from "../ports/benchmark-source.ts";
import { contractRecord } from "../providers/openrouter-contracts.ts";

const SOURCE_ID = "lmarena-hf";
const BASE_URL = "https://datasets-server.huggingface.co/rows";
/** The server's own per-page cap; observed directly against the live API. */
const HF_ROWS_PER_PAGE = 100;

export type LmArenaTransport = (request: Request) => Promise<Response>;

/**
 * Limited to webdev (Code Arena) and agent (Agent Arena); text/text_style_control's "coding"
 * category exists but its "latest" split spans tens of thousands of rows, unbounded compared to
 * these two's few hundred.
 *
 * Dimensions are distinct from AA's (quality-coding-arena, not quality-coding) because the
 * scales don't match: Bradley-Terry rating (~1200-1700) and IPS score (~0) vs AA's 0-100 ratio.
 * withEvidence() averages same-named dimensions with no unit conversion, so sharing a name would
 * blend incompatible scales into a meaningless number. Stored and queryable on their own,
 * intentionally not folded into models.rank's blended "quality" component yet.
 */
const ARENAS: ReadonlyArray<{ config: string; dimension: string; unit: "ratio" }> = [
	{ config: "webdev", dimension: "quality-coding-arena", unit: "ratio" },
	{ config: "agent", dimension: "quality-type-planning-arena", unit: "ratio" },
];

const THINKING_SUFFIX = /\s*\((?:high|xhigh|low|medium|max|fast|thinking|codex-harness)\)\s*$/i;

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new Error(`LMArena benchmark ${name} schema changed`);
	return value;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`LMArena benchmark ${name} schema changed`);
	return value;
}

/**
 * Best-effort: LMArena has no machine identity field, just a display name and org slug. A wrong
 * guess is safe, not a correctness bug -- identity only ever matches exactly against real
 * candidates the caller already supplied, so a bad slug or an unreleased codename ("Inkling")
 * is just inert evidence, never misattributed evidence.
 */
function bestEffortIdentity(organization: string, displayName: string): { provider: string; model: string; aliases: string[] } {
	const base = displayName.replace(THINKING_SUFFIX, "").trim();
	const slug = base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
	return { provider: organization, model: slug, aliases: [displayName.toLowerCase()] };
}

export class LmArenaHfSource implements BenchmarkSource {
	readonly id = SOURCE_ID;

	constructor(
		private readonly transport: LmArenaTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {}

	async fetch(): Promise<BenchmarkSourceSnapshot> {
		const retrievedAt = this.clock();
		if (!Number.isSafeInteger(retrievedAt) || retrievedAt <= 0) throw new Error("benchmark retrieval time is invalid");
		const perArena = await Promise.all(ARENAS.map((arena) => this.fetchArena(arena, retrievedAt)));
		const observations = perArena.flatMap((page) => page.observations).slice(0, BENCHMARK_MAX_MODELS_PER_SOURCE * ARENAS.length);
		const asOf = perArena.map((page) => page.asOf).sort().at(-1) ?? "unknown";
		return { sourceId: this.id, snapshotId: `${this.id}:${asOf}`, retrievedAt, observations };
	}

	private async fetchArena(arena: { config: string; dimension: string; unit: "ratio" }, retrievedAt: number): Promise<{ asOf: string; observations: BenchmarkObservation[] }> {
		const url = `${BASE_URL}?dataset=lmarena-ai%2Fleaderboard-dataset&config=${arena.config}&split=latest&length=${HF_ROWS_PER_PAGE}`;
		const response = await this.transport(new Request(url));
		if (!response.ok) throw new Error(`LMArena benchmark fetch failed with HTTP ${response.status}`);
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > BENCHMARK_SOURCE_MAX_RESPONSE_BYTES) throw new Error("LMArena benchmark response exceeds the size limit");
		let payload: unknown;
		try { payload = JSON.parse(text); } catch { throw new Error("LMArena benchmark response is not valid JSON"); }
		const root = contractRecord(payload, "benchmark response");
		if (!Array.isArray(root["rows"]) || root["rows"].length > HF_ROWS_PER_PAGE) throw new Error("LMArena benchmark row count is invalid");
		let asOf = "";
		const observations = root["rows"].flatMap((entry): BenchmarkObservation[] => {
			const wrapper = contractRecord(entry, "benchmark row wrapper");
			const row = contractRecord(wrapper["row"], "benchmark row");
			const publishDate = requiredText(row["leaderboard_publish_date"], "publish date");
			if (publishDate > asOf) asOf = publishDate;
			// Skip finer per-category splits, if any exist for this config -- out of scope for now.
			if (requiredText(row["category"], "category") !== "overall") return [];
			const scoreValue = row["rating"] ?? row["score"];
			const value = requiredNumber(scoreValue, "score");
			const organization = requiredText(row["organization"], "organization");
			const displayName = requiredText(row["model_name"], "model name");
			const guessed = bestEffortIdentity(organization, displayName);
			const identity = normalizeModelIdentity(guessed.provider, guessed.model, guessed.aliases);
			const provenance = {
				sourceId: SOURCE_ID,
				sourceType: "preference" as const,
				publisher: "LMArena",
				url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
				revision: `${arena.config}:${publishDate}`,
				publishedAt: Date.parse(publishDate) || null,
				retrievedAt,
				freshUntil: retrievedAt + BENCHMARK_REFRESH_INTERVAL_MS,
				license: "See lmarena-ai/leaderboard-dataset on Hugging Face for per-model license terms",
				confidence: 0.6,
			};
			const methodology = { basis: "LMArena human-preference battles", arena: arena.config, displayName, publishDate };
			return [validateBenchmarkObservation({ model: identity, dimension: arena.dimension, value, unit: arena.unit, provenance, methodology })];
		});
		return { asOf, observations };
	}
}
