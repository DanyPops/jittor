import { describe, expect, it } from "bun:test";
import {
	computeToolSchemaLedger,
	contextContributionMetric,
	type ToolLedgerEntry,
	toolLedgerSegment,
	validateContextContribution,
	validateContextSegment,
} from "../src/observability/context-hub.ts";

function contribution() {
	return {
		schema: "jittor.context-contribution/v1",
		observedAt: 1_000,
		sequence: 1,
		producerName: "papyrus",
		segment: {
			key: "rules",
			label: "Active Rules",
			estimatedTokens: 120,
			confidence: "exact-cooperative",
			items: [
				{ label: "Rule A", estimatedTokens: 80 },
				{ label: "Rule B", estimatedTokens: 40 },
			],
		},
	};
}

describe("Context Hub: shared contribution channel", () => {
	it("validates a well-formed contribution and projects a bounded metric", () => {
		const parsed = validateContextContribution(contribution(), 1_500);
		expect(parsed.producerName).toBe("papyrus");
		expect(parsed.segment.estimatedTokens).toBe(120);
		const metric = contextContributionMetric(parsed);
		expect(metric).toMatchObject({ source: "context-hub", scope: "papyrus", metric: "segment-tokens", value: 120, observedAt: 1_000 });
		expect(metric.attributes).toMatchObject({ segmentKey: "rules", confidence: "exact-cooperative", itemCount: 2 });
	});

	it("rejects malformed, stale, or content-bearing payloads", () => {
		expect(() => validateContextContribution({ ...contribution(), schema: "v2" }, 1_500)).toThrow("schema");
		expect(() => validateContextContribution(contribution(), 1_000 + 10 * 60_000)).toThrow("stale");
		expect(() => validateContextContribution({ ...contribution(), extra: "rule body text" }, 1_500)).toThrow("unexpected field");
		expect(() =>
			validateContextContribution({ ...contribution(), segment: { ...contribution().segment, confidence: "definitely" } }, 1_500),
		).toThrow("confidence");
	});

	it("keeps a segment marked unknown visible even at zero tokens, and rejects a non-boolean unknown field", () => {
		const segment = validateContextSegment({
			key: "basePrompt",
			label: "Base prompt",
			estimatedTokens: 0,
			confidence: "exact-structural",
			unknown: true,
		});
		expect(segment.unknown).toBe(true);
		expect(() => validateContextSegment({ key: "x", label: "X", estimatedTokens: 0, confidence: "audited", unknown: "yes" })).toThrow(
			"unknown must be a boolean",
		);
	});

	it("rejects a segment item tree nested past the bound", () => {
		let deep: Record<string, unknown> = { label: "leaf", estimatedTokens: 1 };
		for (let i = 0; i < 8; i++) deep = { label: `level-${i}`, estimatedTokens: 1, children: [deep] };
		expect(() => validateContextSegment({ key: "x", label: "X", estimatedTokens: 1, confidence: "audited", items: [deep] })).toThrow(
			"nesting",
		);
	});

	it("rejects a segment with more total items than the bound", () => {
		const items = Array.from({ length: 501 }, (_, i) => ({ label: `item-${i}`, estimatedTokens: 1 }));
		expect(() => validateContextSegment({ key: "x", label: "X", estimatedTokens: 501, confidence: "audited", items })).toThrow("items");
	});
});

function tool(overrides: Partial<ToolLedgerEntry> = {}): ToolLedgerEntry {
	return { name: "read", description: "Read file contents", ...overrides };
}

describe("Context Hub: tool-schema ledger", () => {
	it("groups tool schema cost by owning extension via sourceInfo.source", () => {
		const tools: ToolLedgerEntry[] = [
			tool({ name: "read", description: "Read file contents", sourceInfo: { source: "builtin" } }),
			tool({ name: "bash", description: "Execute a shell command", sourceInfo: { source: "builtin" } }),
			tool({ name: "jittor_context", description: "Show context usage", sourceInfo: { source: "@danypops/pi-jittor" } }),
		];
		const ledger = computeToolSchemaLedger(tools);
		expect(ledger.map((entry) => entry.source)).toEqual(["builtin", "@danypops/pi-jittor"]);
		const builtin = ledger[0]!;
		expect(builtin.toolCount).toBe(2);
		expect(builtin.characters).toBeGreaterThan(0);
		expect(builtin.tools.map((t) => t.name)).toEqual(["bash", "read"]); // heaviest first: "Execute a shell command" > "Read file contents"
	});

	it('groups a tool with no sourceInfo under "unknown" rather than dropping it', () => {
		const ledger = computeToolSchemaLedger([tool({ sourceInfo: undefined })]);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]!.source).toBe("unknown");
	});

	it("counts parameters schema and prompt guidelines toward a tool's own cost, not just its description", () => {
		const bare = computeToolSchemaLedger([tool({ sourceInfo: { source: "x" } })])[0]!.characters;
		const heavy = computeToolSchemaLedger([
			tool({
				sourceInfo: { source: "x" },
				parameters: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } } },
				promptGuidelines: ["Use read to examine files instead of cat or sed.", "Prefer read over head/tail for viewing file contents."],
			}),
		])[0]!.characters;
		expect(heavy).toBeGreaterThan(bare);
	});

	it("projects the ledger into one exact-tool ContextSegment, heaviest source first", () => {
		const segment = toolLedgerSegment([
			tool({ name: "read", sourceInfo: { source: "builtin" } }),
			tool({
				name: "jittor_context",
				description: "A much, much longer description than the builtin read tool has, to guarantee it sorts first",
				sourceInfo: { source: "@danypops/pi-jittor" },
			}),
		]);
		expect(segment.key).toBe("toolDefinitions");
		expect(segment.confidence).toBe("exact-tool");
		expect(segment.items?.[0]?.label).toContain("@danypops/pi-jittor");
		expect(segment.estimatedTokens).toBeGreaterThan(0);
		expect(validateContextSegment(segment)).toEqual(segment); // round-trips through the same validator contributed segments use
	});
});
