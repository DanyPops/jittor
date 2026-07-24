import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HUMAN_STATUS_MAX_SOURCES,
  SERVICE_MAX_RESPONSE_BYTES,
  USAGE_RENDER_MAX_SERIES,
} from "../src/constants.ts"
import { runCli, formatContextAssessment } from "../src/cli.ts"
import type { ContextAssessment } from "../src/domain/context-telemetry.ts"
import { validateMetricObservation, type StoredMetricObservation } from "../src/domain/metric.ts"
import type { MetricStore } from "../src/ports/metric-store.ts"
import type { RouterStatus } from "../src/ports/router-controller.ts"
import { createApp, JittorService } from "../src/service.ts"
import { buildStatusView } from "../extension/src/tui.ts"
import { renderUsageGraph } from "../extension/src/usage.ts"
import type { UsageGraph } from "../src/domain/usage.ts"

const assessment: ContextAssessment = {
  window: { since: 1_000, until: 2_000 },
  completeness: "complete",
  injection: {
    runs: 2,
    averageCharacters: 100,
    p95Characters: 120,
    maxCharacters: 120,
    estimatedTokens: 50,
    unchangedRate: 0.5,
    averageShare: 0.1,
    ruleCharacters: 80,
    taskCharacters: 120,
  },
  compaction: {
    completed: 1,
    aborted: 0,
    averageDurationMs: 30,
    perRun: 0.5,
    perTurn: 0.25,
    perHour: 1,
    averageTurnsBetween: 4,
    averageElapsedMsBetween: 1_000,
    averageProviderTokensBetween: 2_000,
    averageCacheReadTokensBetween: 500,
    reasons: { manual: 0, threshold: 1, overflow: 0 },
  },
}

function status(sourceCount: number): RouterStatus {
  return {
    ready: true,
    paused: false,
    sources: Array.from({ length: sourceCount }, (_, index) => ({
      id: `source-${index}`,
      provider: "provider",
      ok: index % 2 === 0,
      metrics: index,
      observedAt: 1_000,
      error: "oauth-super-secret must never be presented",
    })),
    lastDecision: null,
    override: null,
    currentRoute: { provider: "provider", model: "model", thinking: "medium" },
    availableRoutes: [],
  }
}

function storeWithRows(rows: StoredMetricObservation[]): MetricStore {
  return {
    record(observation) { return { id: 1, ...observation, attributes: observation.attributes ?? {} } },
    query() { return rows },
    distinctScopes() { return [...new Set(rows.map((row) => row.scope))] },
    aggregateUsage() { return [] },
    pruneBefore() { return 0 },
    checkpoint() {},
    close() {},
  }
}

describe("Jittor output-channel conformance", () => {
  it("classifies native model-tool output as explicitly non-applicable", () => {
    const extension = readFileSync(join(import.meta.dir, "../extension/src/index.ts"), "utf8")
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    const panel = readFileSync(join(import.meta.dir, "../extension/src/tui.ts"), "utf8")
    const documentation = readFileSync(join(import.meta.dir, "../docs/OUTPUT_CHANNELS.md"), "utf8")
    expect(extension).not.toContain("registerTool(")
    expect(extension).toContain("registerCommand(")
    expect(cli).not.toContain("extension/src")
    expect(panel).not.toMatch(/JSON\.(?:parse|stringify)/)
    expect(documentation).toContain("explicitly **not applicable**")
    expect(documentation).toContain("Adding any `registerTool(...)` call requires")
  })

  it("keeps stable CLI JSON independent from the human presenter", async () => {
    const jsonLines: string[] = []
    const humanLines: string[] = []
    const dependencies = {
      client: { async call() { return assessment } } as never,
      stderr() {},
      systemctl() {},
      installService() {},
      serve() {},
    }
    expect(await runCli(["context", "--json"], { ...dependencies, stdout: (line) => jsonLines.push(line) })).toBe(0)
    expect(JSON.parse(jsonLines[0]!)).toEqual(assessment)
    expect(await runCli(["context"], { ...dependencies, stdout: (line) => humanLines.push(line) })).toBe(0)
    expect(humanLines[0]).toBe(formatContextAssessment(assessment))
    expect(humanLines[0]).toContain("Context assessment: complete")
    expect(humanLines[0]).not.toBe(jsonLines[0])
  })

  it("bounds daemon JSON responses independently from request bounds", async () => {
    const rows = Array.from({ length: 1_000 }, (_, id): StoredMetricObservation => ({
      id,
      source: "source",
      scope: "scope",
      metric: "metric",
      value: 1,
      unit: "count",
      observedAt: id,
      attributes: { payload: "x".repeat(8_000) },
    }))
    const app = createApp({ service: new JittorService(storeWithRows(rows)), token: "token" })
    const response = await app.fetch(new Request("http://127.0.0.1/api/v1/ops", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ op: "metrics.query", input: { limit: 1_000 } }),
    }))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "response too large" })
    expect(Number(response.headers.get("content-length"))).toBeLessThanOrEqual(SERVICE_MAX_RESPONSE_BYTES)
  })

  it("rejects oversized or credential-shaped metric attributes at ingress", () => {
    const base = { source: "source", scope: "scope", metric: "metric", value: 1, unit: "count", observedAt: 1 }
    expect(() => validateMetricObservation({ ...base, attributes: { accessToken: "secret" } })).toThrow("sensitive")
    expect(() => validateMetricObservation({ ...base, attributes: { payload: "x".repeat(100_000) } })).toThrow("attributes")
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < 20; depth += 1) nested = { nested }
    expect(() => validateMetricObservation({ ...base, attributes: nested })).toThrow("nesting depth")
  })

  it("bounds and sanitizes human status panels", () => {
    const lines = buildStatusView(status(HUMAN_STATUS_MAX_SOURCES + 20), [], 2_000)
    expect(lines.filter((line) => line.startsWith("  source-")).length).toBe(HUMAN_STATUS_MAX_SOURCES)
    expect(lines.join("\n")).not.toContain("oauth-super-secret")
    expect(lines.join("\n")).toContain("more telemetry sources omitted")
  })

  it("bounds usage legend output regardless of model cardinality", () => {
    const series = Array.from({ length: USAGE_RENDER_MAX_SERIES + 20 }, (_, index) => ({
      key: `provider-${index}/model-${index}`,
      provider: `provider-${index}`,
      model: `model-${index}`,
      total: 1,
    }))
    const graph: UsageGraph = {
      period: "hourly",
      start: 0,
      end: 3_600_000,
      totalTokens: series.length,
      breakdown: { input: series.length, output: 0, cacheRead: 0, cacheWrite: 0 },
      buckets: [{ start: 0, end: 3_600_000, total: series.length, series: Object.fromEntries(series.map((item) => [item.key, 1])) }],
      series,
      truncated: false,
    }
    const lines = renderUsageGraph(graph, 80, { fg: (_color, text) => text, bold: (text) => text })
    expect(lines.filter((line) => line.startsWith("■ ")).length).toBe(USAGE_RENDER_MAX_SERIES)
    expect(lines.join("\n")).toContain("more series omitted")
    expect(lines.every((line) => line.length <= 80)).toBe(true)
  })
})
