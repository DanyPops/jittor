import { describe, expect, it } from "bun:test"
import { OpenRouterBenchmarkIndexSource } from "../src/adapters/openrouter-benchmark-index-source.ts"
import { OpenRouterBenchmarkSource } from "../src/adapters/openrouter-benchmark-source.ts"
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

  it("maps versioned OpenRouter benchmark indices without exposing the API credential", async () => {
    const requests: Request[] = []
    const source = new OpenRouterBenchmarkIndexSource("api-secret", async (request) => {
      requests.push(request)
      return Response.json({
        data: [{ source: "artificial-analysis", model_permaslug: "openai/gpt-5.4", display_name: "GPT 5.4", intelligence_index: 82, coding_index: 91, agentic_index: 88, pricing: { prompt: "0.000002", completion: "0.000010" } }],
        meta: { as_of: "2026-06-01", version: "2026-06-01", source: "artificial-analysis", source_url: "https://artificialanalysis.ai/", citation: "Artificial Analysis", model_count: 1, task_type: "coding" },
      })
    }, () => 2_000_000_000_000)
    const snapshot = await source.fetch()
    expect(requests[0]?.url).toContain("/benchmarks?source=artificial-analysis")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer api-secret")
    expect(snapshot.snapshotId).toContain("2026-06-01")
    expect(snapshot.observations.map((item) => item.dimension)).toEqual(["quality-coding", "quality-general", "quality-planning", "price-input", "price-output"])
    expect(snapshot.observations[0]?.model.aliases).toContain("openrouter/openai/gpt-5.4")
    expect(JSON.stringify(snapshot)).not.toContain("api-secret")
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
