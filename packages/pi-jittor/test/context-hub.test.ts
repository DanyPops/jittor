import { describe, expect, it } from "bun:test";
import { toolLedgerSegment, type ContextSegment } from "@danypops/jittor";
import { ContextHubCapability } from "../extension/src/capabilities/context-hub.ts";
import type { ContextBreakdown } from "../extension/src/context-breakdown.ts";
import { buildContextReport } from "../extension/src/context-report.ts";

function breakdown(overrides: Partial<ContextBreakdown> = {}): ContextBreakdown {
	return { totalTokens: null, contextWindow: null, effectiveBudget: null, overshootTokens: 0, segments: [], ...overrides };
}

function contribution(overrides: Record<string, unknown> = {}) {
	return {
		schema: "jittor.context-contribution/v1",
		observedAt: Date.now(),
		sequence: 1,
		producerName: "papyrus",
		segment: { key: "rules", label: "Active Rules", estimatedTokens: 200, confidence: "exact-cooperative" },
		...overrides,
	};
}

describe("ContextHubCapability", () => {
	it("records a valid contribution and surfaces it as the producer's latest segment", () => {
		const hub = new ContextHubCapability();
		hub.observe(contribution());
		expect(hub.contributedSegments()).toEqual([{ key: "rules", label: "Active Rules", estimatedTokens: 200, confidence: "exact-cooperative" }]);
	});

	it("replaces a producer's segment with its next contribution rather than accumulating stale ones", () => {
		const hub = new ContextHubCapability();
		hub.observe(contribution({ sequence: 1, segment: { key: "rules", label: "Active Rules", estimatedTokens: 200, confidence: "exact-cooperative" } }));
		hub.observe(contribution({ sequence: 2, segment: { key: "rules", label: "Active Rules", estimatedTokens: 260, confidence: "exact-cooperative" } }));
		expect(hub.contributedSegments()).toHaveLength(1);
		expect(hub.contributedSegments()[0]!.estimatedTokens).toBe(260);
	});

	it("keeps segments from two different producers independently", () => {
		const hub = new ContextHubCapability();
		hub.observe(contribution({ producerName: "papyrus" }));
		hub.observe(contribution({ producerName: "lector", segment: { key: "index", label: "Symbol index", estimatedTokens: 50, confidence: "correlated" } }));
		expect(hub.contributedSegments().map((segment) => segment.key).sort()).toEqual(["index", "rules"]);
	});

	it("silently drops a malformed or stale contribution without throwing", () => {
		const hub = new ContextHubCapability();
		expect(() => hub.observe({ garbage: true })).not.toThrow();
		expect(() => hub.observe(contribution({ observedAt: Date.now() - 10 * 60_000 }))).not.toThrow();
		expect(hub.contributedSegments()).toHaveLength(0);
	});

	it("drops a duplicate (same producer + sequence) contribution silently", () => {
		const hub = new ContextHubCapability();
		hub.observe(contribution({ sequence: 5 }));
		hub.observe(contribution({ sequence: 5, segment: { key: "rules", label: "Active Rules", estimatedTokens: 999, confidence: "exact-cooperative" } }));
		expect(hub.contributedSegments()[0]!.estimatedTokens).toBe(200);
	});

	it("reset() clears every producer's segment", () => {
		const hub = new ContextHubCapability();
		hub.observe(contribution());
		hub.reset();
		expect(hub.contributedSegments()).toHaveLength(0);
	});
});

describe("buildContextReport", () => {
	it("reports real usage first, then segments heaviest-first with their confidence tag", () => {
		const segments: ContextSegment[] = [
			{ key: "toolDefinitions", label: "Tool definitions", estimatedTokens: 500, confidence: "exact-tool", items: [{ label: "builtin (4 tools)", estimatedTokens: 500 }] },
			{ key: "rules", label: "Active Rules", estimatedTokens: 1_200, confidence: "exact-cooperative" },
		];
		const report = buildContextReport(breakdown({ totalTokens: 12_000, contextWindow: 200_000, effectiveBudget: 200_000, segments }));
		const lines = report.split("\n");
		expect(lines[0]).toBe("Real usage: 12.0k / 200.0k tokens (6.0% of usable budget)");
		expect(report.indexOf("Active Rules")).toBeLessThan(report.indexOf("Tool definitions")); // heavier segment first
		expect(report).toContain("[exact-cooperative]");
		expect(report).toContain("[exact-tool]");
	});

	it("reports estimate-only when real usage is unknown", () => {
		const report = buildContextReport(breakdown());
		expect(report).toContain("not yet reported");
		expect(report).toContain("no segments observed yet");
	});

	it("bounds rendered items per segment rather than dumping every one", () => {
		const items = Array.from({ length: 20 }, (_, index) => ({ label: `item-${index}`, estimatedTokens: index }));
		const report = buildContextReport(breakdown({ segments: [{ key: "x", label: "X", estimatedTokens: 190, confidence: "audited", items }] }));
		const itemLines = report.split("\n").filter((line) => line.startsWith("  "));
		expect(itemLines).toHaveLength(5);
		expect(itemLines[0]).toContain("item-19"); // heaviest first
	});
});

describe("toolLedgerSegment integration with buildContextReport", () => {
	it("renders a real Pi tool inventory grouped by owning extension", () => {
		const segment = toolLedgerSegment([
			{ name: "read", description: "Read file contents", sourceInfo: { source: "builtin" } },
			{ name: "bash", description: "Execute a shell command", sourceInfo: { source: "builtin" } },
			{ name: "jittor_context", description: "Show context usage", sourceInfo: { source: "@danypops/pi-jittor" } },
		]);
		const report = buildContextReport(breakdown({ totalTokens: 100, contextWindow: 200_000, effectiveBudget: 200_000, segments: [segment] }));
		expect(report).toContain("Tool definitions");
		expect(report).toContain("builtin (2 tools)");
		expect(report).toContain("@danypops/pi-jittor (1 tool)");
	});
});
