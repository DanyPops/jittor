import { describe, expect, it } from "bun:test"
import {
  aggregateModelMetrics,
  classifyTaskFromTools,
  modelRunMetrics,
  validateModelRunObservation,
  type ModelRunObservation,
} from "../src/domain/model-observation.ts"
import type { StoredMetricObservation } from "../src/domain/metric.ts"

function run(overrides: Partial<ModelRunObservation> = {}): ModelRunObservation {
  return {
    runId: "run-1",
    provider: "openai-codex",
    model: "gpt-5.4",
    thinking: "high",
    domain: "coding",
    type: "general",
    startedAt: 1_000,
    firstTokenAt: 1_250,
    completedAt: 2_000,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 20,
    costUsd: 0.01,
    providerResponses: 2,
    toolCalls: 3,
    toolFailures: 1,
    stopReason: "stop",
    explicitOutcome: "unknown",
    ...overrides,
  }
}

function stored(value: number, observedAt: number, metric = "wall-latency"): StoredMetricObservation {
  return {
    id: observedAt,
    source: "local-model",
    scope: "openai-codex/gpt-5.4",
    metric,
    value,
    unit: metric === "output-throughput" ? "tokens-per-second" : "milliseconds",
    observedAt,
    attributes: { provider: "openai-codex", model: "gpt-5.4", thinking: "high", domain: "coding", type: "general", runId: `run-${observedAt}` },
  }
}

describe("local model observations", () => {
  it("enforces a content-free privacy boundary", () => {
    expect(validateModelRunObservation(run()).runId).toBe("run-1")
    for (const forbidden of ["prompt", "response", "content", "toolPayload", "authorization"]) {
      expect(() => validateModelRunObservation({ ...run(), [forbidden]: "private" })).toThrow("unsupported field")
    }
    const metrics = modelRunMetrics(run())
    expect(metrics.every((metric) => Object.keys(metric.attributes ?? {}).every((key) => ["provider", "model", "thinking", "domain", "type", "runId"].includes(key)))).toBe(true)
    expect(JSON.stringify(metrics)).not.toContain("private")
  })

  it("records timing token cache cost reliability tool-loop and explicit outcome dimensions separately", () => {
    const metrics = modelRunMetrics(run({ explicitOutcome: "accepted" }))
    expect(metrics.map((metric) => metric.metric)).toEqual([
      "ttft", "wall-latency", "output-throughput", "input-tokens", "output-tokens", "cache-read-tokens", "cache-write-tokens",
      "cache-read-ratio", "cost", "provider-responses", "retry-count", "tool-calls", "tool-failures", "failure", "outcome-accepted",
    ])
    expect(metrics.every((metric) => metric.source === "local-model")).toBe(true)
    expect(metrics.every((metric) => metric.attributes?.domain === "coding" && metric.attributes?.type === "general")).toBe(true)
  })

  it("classifies domain and type from bounded tool names without inspecting payloads", () => {
    expect(classifyTaskFromTools(["read", "edit", "bash"])).toEqual({ domain: "coding", type: "general" })
    expect(classifyTaskFromTools(["web_fetch"])).toEqual({ domain: "general", type: "research" })
    expect(classifyTaskFromTools(["tasks"])).toEqual({ domain: "general", type: "planning" })
    expect(classifyTaskFromTools([])).toEqual({ domain: "general", type: "general" })
  })

  it("scores domain and type independently -- a run can be domain=coding and type=research at once", () => {
    expect(classifyTaskFromTools(["read", "edit", "web_fetch"])).toEqual({ domain: "coding", type: "research" })
    expect(classifyTaskFromTools(["bash", "tasks"])).toEqual({ domain: "coding", type: "planning" })
  })

  it("accepts the design domain (Design Arena evidence) through validateModelRunObservation and aggregateModelMetrics, same as coding", () => {
    const designRun = run({ domain: "design", type: "general" })
    expect(validateModelRunObservation(designRun).domain).toBe("design")
    const designStored = stored(1380, 1_000)
    designStored.attributes = { ...designStored.attributes, domain: "design" }
    const groups = aggregateModelMetrics([designStored], { now: 2_000, freshForMs: 10_000 })
    expect(groups.some((group) => group.domain === "design")).toBe(true)
  })

  it("accepts the math domain (Artificial Analysis direct evidence) through validateModelRunObservation and aggregateModelMetrics, same as coding and design", () => {
    const mathRun = run({ domain: "math", type: "general" })
    expect(validateModelRunObservation(mathRun).domain).toBe("math")
    const mathStored = stored(87.2, 1_000)
    mathStored.attributes = { ...mathStored.attributes, domain: "math" }
    const groups = aggregateModelMetrics([mathStored], { now: 2_000, freshForMs: 10_000 })
    expect(groups.some((group) => group.domain === "math")).toBe(true)
  })

  it("aggregates robustly with sample size dispersion recency and confidence", () => {
    const metrics = [stored(100, 1_000), stored(110, 2_000), stored(10_000, 3_000), stored(50, 3_000, "output-throughput")]
    const groups = aggregateModelMetrics(metrics, { now: 4_000, freshForMs: 10_000 })
    const latency = groups.find((group) => group.dimension === "wall-latency")!
    expect(latency).toMatchObject({ sampleSize: 3, median: 110, medianAbsoluteDeviation: 10, latestAt: 3_000 })
    expect(latency.p90).toBe(10_000)
    expect(latency.confidence).toBeGreaterThan(0)
    expect(latency.confidence).toBeLessThan(1)
    expect(groups.find((group) => group.dimension === "output-throughput")?.sampleSize).toBe(1)
  })

  it("marks stale aggregates with zero freshness confidence", () => {
    const [aggregate] = aggregateModelMetrics([stored(100, 1_000)], { now: 20_000, freshForMs: 10_000 })
    expect(aggregate?.freshness).toBe("stale")
    expect(aggregate?.confidence).toBe(0)
  })
})
