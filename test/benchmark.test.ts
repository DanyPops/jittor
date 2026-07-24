import { describe, expect, it } from "bun:test"
import { OpenRouterBenchmarkSource } from "../src/adapters/openrouter-benchmark-source.ts"
import { OpenRouterDesignArenaSource } from "../src/adapters/openrouter-design-arena-source.ts"
import { LmArenaHfSource } from "../src/adapters/lmarena-hf-source.ts"
import { ArtificialAnalysisDirectSource } from "../src/adapters/artificial-analysis-direct-source.ts"
import { MetricBenchmarkStore } from "../src/adapters/metric-benchmark-store.ts"
import {
  BenchmarkCatalog,
  normalizeModelIdentity,
  validateBenchmarkObservation,
  type BenchmarkObservation,
  type BenchmarkSource,
} from "../src/domain/benchmark.ts"
import type { MetricObservation, MetricQuery, StoredMetricObservation } from "../src/domain/metric.ts"
import type { MetricStore } from "../src/ports/metric-store.ts"
import { JittorService } from "../src/service.ts"

class MemoryMetricStore implements MetricStore {
  rows: StoredMetricObservation[] = []

  record(input: MetricObservation): StoredMetricObservation {
    const row = { ...input, id: this.rows.length + 1, attributes: input.attributes ?? {} }
    this.rows.push(row)
    return row
  }

  query(filter: MetricQuery = {}): StoredMetricObservation[] {
    const rows = this.rows.filter((row) =>
      (filter.source === undefined || row.source === filter.source)
      && (filter.scope === undefined || row.scope === filter.scope)
      && (filter.metric === undefined || row.metric === filter.metric)
      && (filter.since === undefined || row.observedAt >= filter.since)
      && (filter.until === undefined || row.observedAt <= filter.until))
    const ordered = filter.order === "desc" ? [...rows].reverse() : rows
    return ordered.slice(0, filter.limit ?? 1_000)
  }

  distinctScopes(filter: { source: string; since: number; until: number; limit: number }): string[] {
    return [...new Set(this.rows.filter((row) => row.source === filter.source && row.observedAt >= filter.since && row.observedAt <= filter.until).map((row) => row.scope))].sort().slice(0, filter.limit)
  }

  aggregateUsage(): never[] { return [] }

  pruneBefore(): number { return 0 }
  checkpoint(): void {}
  close(): void {}
}

function observation(overrides: Partial<BenchmarkObservation> = {}): BenchmarkObservation {
  return {
    model: { provider: "openai", model: "gpt-5.4", version: null, canonical: "openai/gpt-5.4", aliases: [] },
    dimension: "price-input",
    value: 0.000_002,
    unit: "usd",
    provenance: {
      sourceId: "openrouter-models",
      sourceType: "marketplace",
      publisher: "OpenRouter",
      url: "https://openrouter.ai/api/v1/models",
      revision: "retrieved:1000",
      publishedAt: null,
      retrievedAt: 1_000,
      freshUntil: 100_000,
      license: "OpenRouter API terms",
      confidence: 0.9,
    },
    methodology: { basis: "price per input token" },
    ...overrides,
  }
}

function modelPayload(id = "openai/gpt-5.4"): Record<string, unknown> {
  return {
    data: [{
      id,
      canonical_slug: id,
      name: "GPT 5.4",
      context_length: 1_000_000,
      pricing: { prompt: "0.000002", completion: "0.000010", request: "0" },
      top_provider: { max_completion_tokens: 128_000 },
      supported_parameters: ["tools", "reasoning"],
      expiration_date: null,
    }],
  }
}

describe("benchmark evidence", () => {
  it("normalizes provider identities without merging dated versions", () => {
    expect(normalizeModelIdentity(" OpenAI ", "GPT-5.4 ", ["openrouter/openai/gpt-5.4"])).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      version: null,
      canonical: "openai/gpt-5.4",
      aliases: ["openrouter/openai/gpt-5.4"],
    })
    expect(normalizeModelIdentity("openai", "gpt-5.4-2026-03-01").version).toBe("2026-03-01")
    expect(normalizeModelIdentity("openai", "gpt-5.4-2026-03-01").canonical).not.toBe(normalizeModelIdentity("openai", "gpt-5.4").canonical)
  })

  it("rejects facts without bounded provenance, freshness, confidence, or license", () => {
    expect(validateBenchmarkObservation(observation()).provenance.sourceId).toBe("openrouter-models")
    expect(() => validateBenchmarkObservation(observation({ provenance: { ...observation().provenance, url: "not-a-url" } }))).toThrow("URL")
    expect(() => validateBenchmarkObservation(observation({ provenance: { ...observation().provenance, confidence: 2 } }))).toThrow("confidence")
    expect(() => validateBenchmarkObservation(observation({ provenance: { ...observation().provenance, retrievedAt: 0 } }))).toThrow("retrieval")
    expect(() => validateBenchmarkObservation(observation({ provenance: { ...observation().provenance, freshUntil: 999 } }))).toThrow("freshness")
    expect(() => validateBenchmarkObservation(observation({ provenance: { ...observation().provenance, license: "" } }))).toThrow("license")
  })

  it("publishes only complete immutable snapshots through the metric-store port", () => {
    const metrics = new MemoryMetricStore()
    const store = new MetricBenchmarkStore(metrics)
    store.publish("openrouter-models", "snapshot-1", [observation()])
    expect(store.latest("openrouter-models")).toMatchObject({ snapshotId: "snapshot-1", observations: [{ dimension: "price-input" }] })

    metrics.record({ source: "benchmark:openrouter-models", scope: "openai/gpt-broken", metric: "price-input", value: 1, unit: "usd", observedAt: 2_000, attributes: { snapshotId: "snapshot-incomplete" } })
    expect(store.latest("openrouter-models")?.snapshotId).toBe("snapshot-1")
  })

  it("maps bounded OpenRouter model facts with source-specific provenance", async () => {
    const requests: Request[] = []
    const source = new OpenRouterBenchmarkSource(async (request) => {
      requests.push(request)
      return Response.json(modelPayload())
    }, () => 1_000)
    const snapshot = await source.fetch()
    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining("/models?limit="), expect.stringContaining("sort=latency-low-to-high"), expect.stringContaining("sort=throughput-high-to-low"),
    ])
    expect(snapshot.observations.map((item) => item.dimension)).toEqual([
      "context-window", "max-output", "price-input", "price-output", "parameter-count", "latency-rank", "throughput-rank",
    ])
    expect(snapshot.observations.every((item) => item.provenance.sourceType === "marketplace")).toBe(true)
    expect(snapshot.observations.every((item) => item.model.canonical === "openai/gpt-5.4")).toBe(true)
  })

  it("fetches a curated allowlist of Design Arena categories, tags them one quality-design dimension, and drops OpenRouter-unreachable models", async () => {
    const requests: Request[] = []
    const source = new OpenRouterDesignArenaSource("api-secret", async (request) => {
      requests.push(request)
      const category = new URL(request.url).searchParams.get("task_type")
      return Response.json({
        data: [
          { source: "design-arena", open_router_id: "anthropic/claude-sonnet-4", elo: 1380, win_rate: 63.0 },
          { source: "design-arena", open_router_id: null, elo: 1340, win_rate: 62.0 },
        ],
        meta: { as_of: "2026-06-01", source: "design-arena", category },
      })
    }, () => 2_000_000_000_000)
    const snapshot = await source.fetch()
    expect(requests).toHaveLength(5)
    expect(requests.map((request) => new URL(request.url).searchParams.get("task_type")).sort()).toEqual(["codecategories", "dataviz", "svg", "uicomponent", "website"])
    expect(requests.every((request) => request.url.includes("source=design-arena"))).toBe(true)
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer api-secret")).toBe(true)
    // Five categories, one non-null-openRouterId row each -- the null-id row is dropped every time.
    expect(snapshot.observations).toHaveLength(5)
    expect(snapshot.observations.every((item) => item.dimension === "quality-design")).toBe(true)
    expect(snapshot.observations.every((item) => item.unit === "elo")).toBe(true)
    expect(snapshot.observations.every((item) => item.value === 1380)).toBe(true)
    expect(snapshot.observations.every((item) => item.model.canonical === "anthropic/claude-sonnet-4")).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("api-secret")
  })

  it("fails closed on Design Arena schema drift instead of guessing a shape", async () => {
    const source = new OpenRouterDesignArenaSource("api-secret", async () => Response.json({
      data: [{ source: "design-arena", open_router_id: "anthropic/claude-sonnet-4" /* elo missing */ }],
      meta: { as_of: "2026-06-01", source: "design-arena" },
    }), () => 2_000_000_000_000)
    await expect(source.fetch()).rejects.toThrow("schema changed")
  })

  it("tags LMArena arena evidence under its own dimensions, never the AA-scale quality-coding/quality-type-planning ones", async () => {
    const requests: Request[] = []
    const source = new LmArenaHfSource(async (request) => {
      requests.push(request)
      const config = new URL(request.url).searchParams.get("config")
      const row = config === "webdev"
        ? { model_name: "Claude Fable 5 (High)", organization: "anthropic", license: "Proprietary", rating: 1633.6, rating_lower: 1621.4, rating_upper: 1645.8, variance: 38.6, vote_count: 3021, rank: 1, category: "overall", leaderboard_publish_date: "2026-07-21" }
        : { model_name: "Claude Fable 5 (High)", organization: "anthropic", license: "Proprietary", score: 0.127, score_ci_lower: 0.107, score_ci_upper: 0.147, observation_count: 831160, session_count: 23549, rank: 1, category: "overall", leaderboard_publish_date: "2026-07-21" }
      return Response.json({ rows: [{ row_idx: 0, row, truncated_cells: [] }], num_rows_total: 1, num_rows_per_page: 100, partial: false })
    }, () => 2_000_000_000_000)
    const snapshot = await source.fetch()
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => new URL(request.url).searchParams.get("config")).sort()).toEqual(["agent", "webdev"])
    expect(requests.every((request) => request.url.includes("dataset=lmarena-ai%2Fleaderboard-dataset"))).toBe(true)
    expect(snapshot.observations.map((item) => item.dimension).sort()).toEqual(["quality-coding-arena", "quality-type-planning-arena"])
    // Distinct from AA's/Design Arena's dimensions, so ranking's flat per-dimension average never blends a ~1600 Bradley-Terry rating with a 0-100 index.
    expect(snapshot.observations.every((item) => item.dimension !== "quality-coding" && item.dimension !== "quality-type-planning")).toBe(true)
    expect(snapshot.observations.every((item) => item.model.provider === "anthropic" && item.model.model === "claude-fable-5")).toBe(true)
    expect(snapshot.observations.every((item) => item.provenance.sourceType === "preference")).toBe(true)
  })

  it("skips non-overall LMArena rows and fails closed on schema drift", async () => {
    const withNonOverall = new LmArenaHfSource(async () => Response.json({
      rows: [
        { row_idx: 0, row: { model_name: "Model A", organization: "openai", rating: 1500, rank: 2, category: "coding", leaderboard_publish_date: "2026-07-21" }, truncated_cells: [] },
      ],
      num_rows_total: 1, num_rows_per_page: 100, partial: false,
    }), () => 2_000_000_000_000)
    expect((await withNonOverall.fetch()).observations).toHaveLength(0)

    const malformed = new LmArenaHfSource(async () => Response.json({
      rows: [{ row_idx: 0, row: { model_name: "Model A", organization: "openai", category: "overall", leaderboard_publish_date: "2026-07-21" /* no rating/score */ }, truncated_cells: [] }],
      num_rows_total: 1, num_rows_per_page: 100, partial: false,
    }), () => 2_000_000_000_000)
    await expect(malformed.fetch()).rejects.toThrow("schema changed")
  })

  it("maps Artificial Analysis's direct API into the SAME dimensions as the OpenRouter passthrough, plus a new quality-math domain and measured latency", async () => {
    const requests: Request[] = []
    const source = new ArtificialAnalysisDirectSource("aa-secret", async (request) => {
      requests.push(request)
      return Response.json({
        status: 200,
        data: [{
          id: "model-1", name: "o3-mini", slug: "o3-mini",
          model_creator: { id: "creator-1", name: "OpenAI", slug: "openai" },
          evaluations: { artificial_analysis_intelligence_index: 62.9, artificial_analysis_coding_index: 55.8, artificial_analysis_math_index: 87.2, gpqa: 0.748 },
          pricing: { price_1m_input_tokens: 1.1, price_1m_output_tokens: 4.4 },
          median_output_tokens_per_second: 153.831,
          median_time_to_first_token_seconds: 14.939,
        }],
      })
    }, () => 2_000_000_000_000)
    const snapshot = await source.fetch()
    expect(requests[0]?.url).toBe("https://artificialanalysis.ai/api/v2/data/llms/models")
    expect(requests[0]?.headers.get("x-api-key")).toBe("aa-secret")
    expect(snapshot.observations.map((item) => item.dimension).sort()).toEqual(["latency", "quality-coding", "quality-general", "quality-math"])
    expect(snapshot.observations.find((item) => item.dimension === "quality-math")?.value).toBe(87.2)
    expect(snapshot.observations.find((item) => item.dimension === "latency")?.value).toBe(14_939)
    expect(snapshot.observations.find((item) => item.dimension === "latency")?.unit).toBe("milliseconds")
    expect(snapshot.observations.every((item) => item.model.canonical === "openai/o3-mini")).toBe(true)
    expect(snapshot.observations.every((item) => item.provenance.sourceType === "creator")).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("aa-secret")
  })

  it("omits a dimension entirely when Artificial Analysis has no evaluation for it, rather than fabricating a zero", async () => {
    const source = new ArtificialAnalysisDirectSource("aa-secret", async () => Response.json({
      status: 200,
      data: [{
        id: "model-2", name: "tiny-model", slug: "tiny-model",
        model_creator: { id: "creator-2", name: "Tiny Labs", slug: "tinylabs" },
        evaluations: { artificial_analysis_intelligence_index: 40.1 },
      }],
    }), () => 2_000_000_000_000)
    const snapshot = await source.fetch()
    expect(snapshot.observations.map((item) => item.dimension)).toEqual(["quality-general"])
  })

  it("retains last known evidence and reports schema drift without partial publication", async () => {
    const metrics = new MemoryMetricStore()
    const store = new MetricBenchmarkStore(metrics)
    let fail = false
    const source: BenchmarkSource = {
      id: "openrouter-models",
      async fetch() {
        if (fail) throw new Error("OpenRouter models schema changed")
        return { sourceId: this.id, snapshotId: "snapshot-1", retrievedAt: 1_000, observations: [observation()] }
      },
    }
    let now = 2_000
    const catalog = new BenchmarkCatalog(store, [source], { clock: () => now, refreshIntervalMs: 100 })
    expect((await catalog.refresh(true)).sources[0]).toMatchObject({ ok: true, observations: 1 })
    fail = true
    expect((await catalog.refresh(true)).sources[0]).toMatchObject({ ok: false, error: "source refresh failed" })
    expect(catalog.query({ sourceId: "openrouter-models" })).toMatchObject({ snapshotId: "snapshot-1", freshness: "fresh" })
    now = 100_001
    expect(catalog.query({ sourceId: "openrouter-models" }).freshness).toBe("stale")
    expect(catalog.status().sources[0]).toMatchObject({ ok: false, hasEvidence: true, lastSuccessAt: 1_000 })
  })

  it("exposes typed refresh, status, and query daemon operations", async () => {
    const metrics = new MemoryMetricStore()
    const source: BenchmarkSource = {
      id: "openrouter-models",
      async fetch() { return { sourceId: this.id, snapshotId: "snapshot-1", retrievedAt: 1_000, observations: [observation()] } },
    }
    const catalog = new BenchmarkCatalog(new MetricBenchmarkStore(metrics), [source], { clock: () => 2_000 })
    const service = new JittorService(metrics, undefined, catalog)
    expect(service.operationNames()).toContain("benchmark.refresh")
    expect(await service.execute("benchmark.refresh", { force: true })).toMatchObject({ sources: [{ ok: true }] })
    expect(await service.execute("benchmark.status", {})).toMatchObject({ sources: [{ hasEvidence: true }] })
    expect(await service.execute("benchmark.query", { sourceId: "openrouter-models" })).toMatchObject({ snapshotId: "snapshot-1", completeness: "complete" })
  })

  it("bounds source output and refresh frequency", async () => {
    let calls = 0
    const source: BenchmarkSource = {
      id: "bounded-source",
      async fetch() {
        calls += 1
        return { sourceId: this.id, snapshotId: `snapshot-${calls}`, retrievedAt: calls, observations: [observation({ provenance: { ...observation().provenance, sourceId: this.id, retrievedAt: calls } })] }
      },
    }
    const catalog = new BenchmarkCatalog(new MetricBenchmarkStore(new MemoryMetricStore()), [source], { clock: () => 10, refreshIntervalMs: 1_000 })
    await catalog.refresh()
    await catalog.refresh()
    expect(calls).toBe(1)
  })
})
