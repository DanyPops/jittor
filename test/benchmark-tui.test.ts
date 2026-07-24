import { describe, expect, it } from "bun:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import { BENCHMARK_TUI_MAX_CANDIDATES } from "../src/constants.ts"
import type { ModelRankingResult } from "../src/domain/model-ranking.ts"
import { renderBenchmarkView, showBenchmarkPanel } from "../extension/src/benchmark-tui.ts"

function ranking(count = 2): ModelRankingResult {
  return {
    scopeAuthority: "available-models",
    scopeWarning: "Pi available models are not the exact session scope; automatic selection is disabled",
    domain: "coding",
    type: "general",
    completeness: "partial",
    automaticSelection: null,
    ranked: Array.from({ length: count }, (_, index) => ({
      candidate: { provider: index % 2 ? "anthropic" : "openai", model: `model-${index}`, thinking: "high" },
      identity: `${index % 2 ? "anthropic" : "openai"}/model-${index}:high`,
      utility: 0.9 - (index / 100), confidence: 0.8,
      components: ["quality", "cost", "latency", "context", "reliability"].map((name) => ({ name: name as any, score: 0.75, confidence: 0.8, weight: 1, evidenceCount: name === "reliability" ? 10 : 2, reason: name === "reliability" ? "10 local reliability observations" : "2 external observations" })),
      provenance: [{ sourceId: "openrouter-models", publisher: "OpenRouter", url: "https://openrouter.ai/api/v1/models", revision: "r1", freshness: "fresh" }],
      trace: ["domain coding, type general", "budget pressure 0.500 makes cost weight 3.000"],
    })),
  }
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text }

describe("benchmark recommendation TUI", () => {
  it("renders bounded responsive candidates with explicit advisory scope", () => {
    const lines = renderBenchmarkView(ranking(BENCHMARK_TUI_MAX_CANDIDATES + 10), "anthropic/model-1", 48, theme)
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true)
    expect(lines.join("\n")).toContain("ADVISORY")
    expect(lines.join("\n")).toContain("more candidates omitted")
    expect(lines.filter((line) => /^ \d+\./.test(line)).length).toBe(BENCHMARK_TUI_MAX_CANDIDATES)
  })

  it("shows utility components confidence local sample evidence and provenance freshness", () => {
    const text = renderBenchmarkView(ranking(), "anthropic/model-1", 100, theme).join("\n")
    expect(text).toContain("Q 0.750")
    expect(text).toContain("$ 0.750")
    expect(text).toContain("L 0.750")
    expect(text).toContain("C 0.750")
    expect(text).toContain("R 0.750")
    expect(text).toContain("confidence 80%")
    expect(text).toContain("local n=10")
    expect(text).toContain("openrouter-models@r1 fresh")
    expect(text).toContain("differs from current")
  })

  it("does not expose a selection action for available-model authority", async () => {
    let component: any
    const calls: Array<{ operation: string; input: unknown }> = []
    const ctx = {
      mode: "tui",
      ui: {
        async custom(factory: Function) {
          component = factory({}, theme, {}, () => undefined)
          return "close"
        },
        notify() {},
      },
    }
    const client = { async call(operation: string, input: unknown) { calls.push({ operation, input }); return operation === "models.rank" ? ranking() : { observedAt: 1, sources: [] } } }
    await showBenchmarkPanel(ctx as never, client, [{ provider: "openai", model: "model-0", thinking: "high" }], "openai/model-1", "coding", "general")
    expect(calls[0]).toMatchObject({ operation: "models.rank", input: { scopeAuthority: "available-models" } })
    expect(component.render(80).join("\n")).not.toMatch(/(?:Enter|s|a) (?:select|apply|activate)/i)
  })
})
