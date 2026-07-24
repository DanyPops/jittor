import { describe, expect, it } from "bun:test"
import { EvidenceModelRanker } from "../src/domain/model-ranking-service.ts"
import { rankModelCandidates, type ModelRankingInput } from "../src/domain/model-ranking.ts"
import type { BenchmarkObservation } from "../src/domain/benchmark.ts"
import type { ModelMetricAggregate } from "../src/domain/model-observation.ts"
import type { MetricStore } from "../src/ports/metric-store.ts"
import { JittorService } from "../src/service.ts"

const candidates = [
  { provider: "openai", model: "gpt-fast", thinking: "high" },
  { provider: "anthropic", model: "claude-strong", thinking: "high" },
]

function evidence(provider: string, model: string, dimension: string, value: number, confidence = 0.9, freshUntil = 10_000): BenchmarkObservation {
  return {
    model: { provider, model, version: null, canonical: `${provider}/${model}`, aliases: [] }, dimension, value,
    unit: dimension.startsWith("price") ? "usd" : dimension === "latency" ? "milliseconds" : "ratio",
    provenance: { sourceId: "benchmark", sourceType: "independent", publisher: "Benchmark", url: "https://example.com/results", revision: "r1", publishedAt: 500, retrievedAt: 1_000, freshUntil, license: "CC-BY-4.0", confidence },
    methodology: { dataset: "v1" },
  }
}

function local(provider: string, model: string, dimension: string, median: number, confidence = 0.8): ModelMetricAggregate {
  return { provider, model, thinking: "high", domain: "coding", type: "general", dimension, unit: dimension === "wall-latency" ? "milliseconds" : "ratio", sampleSize: 10, median, p90: median, medianAbsoluteDeviation: 0, latestAt: 1_000, freshness: "fresh", confidence }
}

function input(overrides: Partial<ModelRankingInput> = {}): ModelRankingInput {
  return {
    candidates,
    scopeAuthority: "available-models",
    domain: "coding",
    type: "general",
    budgetPressure: 0.5,
    weights: { quality: 3, cost: 2, latency: 1, context: 1, reliability: 2 },
    externalEvidence: [
      evidence("openai", "gpt-fast", "quality-coding", 0.7), evidence("anthropic", "claude-strong", "quality-coding", 0.9),
      evidence("openai", "gpt-fast", "price-input", 1), evidence("anthropic", "claude-strong", "price-input", 3),
      evidence("openai", "gpt-fast", "latency", 100), evidence("anthropic", "claude-strong", "latency", 300),
    ],
    localEvidence: [local("openai", "gpt-fast", "failure", 0.1), local("anthropic", "claude-strong", "failure", 0.05)],
    now: 2_000,
    ...overrides,
  }
}

describe("model utility ranking", () => {
  it("is deterministic with component weights confidence provenance and stable tie breaks", () => {
    const first = rankModelCandidates(input())
    const second = rankModelCandidates(input({ candidates: [...candidates].reverse() }))
    expect(first.ranked.map((item) => item.identity)).toEqual(second.ranked.map((item) => item.identity))
    expect(first.ranked[0]?.components.map((component) => component.name)).toEqual(["quality", "cost", "latency", "context", "reliability"])
    expect(first.ranked[0]?.trace.join("\n")).toContain("budget pressure")
    expect(first.ranked.flatMap((item) => item.provenance).some((item) => item.sourceId === "benchmark" && item.revision === "r1")).toBe(true)
  })

  it("never adds a candidate from evidence", () => {
    const result = rankModelCandidates(input({ externalEvidence: [...input().externalEvidence, evidence("google", "gemini-extra", "quality-coding", 1)] }))
    expect(result.ranked.map((item) => item.identity).sort()).toEqual(candidates.map((item) => `${item.provider}/${item.model}:${item.thinking}`).sort())
  })

  it("keeps missing scores unknown and lowers confidence instead of assigning zero", () => {
    const result = rankModelCandidates(input({ externalEvidence: [], localEvidence: [] }))
    expect(result.ranked.every((item) => item.components.every((component) => component.score === null))).toBe(true)
    expect(result.ranked.every((item) => item.confidence === 0 && item.utility === null)).toBe(true)
    expect(result.completeness).toBe("insufficient-evidence")
  })

  it("weighs domain-quality and type-quality evidence independently, both on top of the universal general fallback", () => {
    // gpt-fast only has domain (coding) evidence; claude-strong only has type (planning/agentic) evidence.
    // Neither should be treated as having zero quality evidence -- each axis is genuinely optional.
    const result = rankModelCandidates(input({
      domain: "coding", type: "planning",
      externalEvidence: [
        evidence("openai", "gpt-fast", "quality-coding", 0.9),
        evidence("anthropic", "claude-strong", "quality-type-planning", 0.9),
      ],
      localEvidence: [],
    }))
    expect(result.ranked.every((item) => item.components.find((component) => component.name === "quality")?.score !== null)).toBe(true)
  })

  it("falls back to quality-general when neither domain nor type has specific evidence", () => {
    const result = rankModelCandidates(input({
      domain: "general", type: "general",
      externalEvidence: [evidence("openai", "gpt-fast", "quality-general", 0.8)],
      localEvidence: [],
    }))
    const quality = result.ranked.find((item) => item.identity.startsWith("openai/"))?.components.find((item) => item.name === "quality")
    expect(quality?.score).not.toBeNull()
  })

  it("reduces confidence for stale evidence while retaining its provenance", () => {
    const stale = evidence("openai", "gpt-fast", "quality-coding", 0.9, 0.9, 1_500)
    const result = rankModelCandidates(input({ externalEvidence: [stale], localEvidence: [], now: 2_000 }))
    const quality = result.ranked.find((item) => item.identity.startsWith("openai/"))?.components.find((item) => item.name === "quality")
    expect(quality?.score).not.toBeNull()
    expect(quality?.confidence).toBeLessThan(stale.provenance.confidence)
    expect(result.ranked.flatMap((item) => item.provenance)).toContainEqual(expect.objectContaining({ freshness: "stale" }))
  })

  it("exposes ranking through the authenticated operation service without accepting evidence in the request", async () => {
    const benchmark = evidence("openai", "gpt-fast", "quality-coding", 0.7)
    const benchmarkStore = { publish() { throw new Error("unused") }, latest(sourceId: string) { return sourceId === "benchmark" ? { sourceId, snapshotId: "s1", retrievedAt: 1_000, publishedAt: 1_000, observations: [benchmark] } : null } }
    const metrics: MetricStore = { record() { throw new Error("unused") }, query() { return [] }, distinctScopes() { return [] }, aggregateUsage() { return [] }, pruneBefore() { return 0 }, checkpoint() {}, close() {} }
    const ranker = new EvidenceModelRanker(benchmarkStore, metrics, () => 2_000)
    const service = new JittorService(metrics, undefined, undefined, ranker)
    const result = await service.execute("models.rank", {
      candidates, scopeAuthority: "available-models", domain: "coding", type: "general", budgetPressure: 0.5,
      weights: { quality: 3, cost: 2, latency: 1, context: 1, reliability: 2 }, sourceIds: ["benchmark"],
    })
    expect(service.operationNames()).toContain("models.rank")
    expect(result.ranked).toHaveLength(2)
    expect(result.automaticSelection).toBeNull()
  })

  it("keeps available-model scope advisory and permits selection only for exact session scope", () => {
    const advisory = rankModelCandidates(input({ scopeAuthority: "available-models" }))
    expect(advisory.automaticSelection).toBeNull()
    expect(advisory.scopeWarning).toContain("not the exact session scope")
    const exact = rankModelCandidates(input({ scopeAuthority: "exact-session" }))
    expect(exact.automaticSelection).toEqual(exact.ranked[0]!.candidate)
    expect(exact.ranked.every((item) => candidates.some((candidate) => candidate.provider === item.candidate.provider && candidate.model === item.candidate.model))).toBe(true)
  })
})
