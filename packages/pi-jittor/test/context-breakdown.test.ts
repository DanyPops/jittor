import { describe, expect, it } from "bun:test";
import type { ContextSegment } from "@danypops/jittor";
import {
	basePromptSegment,
	buildBasePromptItems,
	buildMessageHistoryTree,
	composeContextBreakdown,
	messageHistorySegment,
	type SessionEntryLike,
	type SessionTreeNodeLike,
} from "../extension/src/observability/context-breakdown.ts";

function node(id: string, entry: Partial<SessionEntryLike> & { type: string }, children: SessionTreeNodeLike[] = []): SessionTreeNodeLike {
	return { entry: { id, type: entry.type, message: entry.message, summary: entry.summary }, children };
}

describe("buildMessageHistoryTree", () => {
	it("walks the real tree (not just the active branch), sizing each node's own text content", () => {
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } })];
		const result = buildMessageHistoryTree(tree, new Set(["1"]));
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.estimatedTokens).toBe(Math.ceil(40 / 4));
		expect(result.activeTokens).toBe(Math.ceil(40 / 4));
	});

	it("preserves real branching as nested children, matching Pi's own tree structure", () => {
		const child = node("2", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } }, [child])];
		const result = buildMessageHistoryTree(tree, new Set(["1", "2"]));
		const assistant = result.items[0]!.children!.find((item) => item.label.includes("assistant"));
		expect(assistant).toBeDefined();
		expect(assistant!.estimatedTokens).toBe(Math.ceil(40 / 4));
	});

	it("labels a branch not on the active path distinctly, and excludes it from activeTokens", () => {
		const abandoned = node("2b", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(40) }] } });
		const active = node("2a", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } }, [active, abandoned])];
		const result = buildMessageHistoryTree(tree, new Set(["1", "2a"]));
		const root = result.items[0]!;
		const activeChild = root.children!.find((child) => child.label.includes("assistant") && !child.label.includes("inactive"))!;
		const abandonedChild = root.children!.find((child) => child.label.includes("inactive branch"))!;
		expect(activeChild).toBeDefined();
		expect(abandonedChild).toBeDefined();
		expect(result.activeTokens).toBe(Math.ceil(40 / 4) * 2);
	});

	it("labels an entry excluded by compaction (still on the branch path) distinctly from a genuinely abandoned /tree branch", () => {
		const compactionEntry = node("2", { type: "compaction", summary: "s".repeat(40) });
		const kept = node("3", { type: "message", message: { role: "user", content: "kept".repeat(10) } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "old".repeat(40) } }, [compactionEntry])];
		compactionEntry.children.push(kept);
		const activeEntryIds = new Set(["2", "3"]);
		const branchEntryIds = new Set(["1", "2", "3"]);
		const result = buildMessageHistoryTree(tree, activeEntryIds, branchEntryIds);
		const compactedAway = result.items[0]!;
		expect(compactedAway.label).toContain("(compacted)");
		expect(compactedAway.label).not.toContain("inactive branch");
		expect(result.activeTokens).toBe(Math.ceil(40 / 4) + Math.ceil(40 / 4));
	});

	it("falls back to the old binary active/inactive-branch labeling when branchEntryIds is omitted", () => {
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } })];
		const result = buildMessageHistoryTree(tree, new Set());
		expect(result.items[0]!.label).toContain("(inactive branch)");
		expect(result.items[0]!.label).not.toContain("(compacted)");
	});

	it("exposes granular text, thinking, and named tool-call argument costs under each message", () => {
		const tree = [
			node("1", {
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "a".repeat(20) },
						{ type: "toolCall", name: "read", arguments: { path: "b".repeat(20) } },
					],
				},
			}),
		];
		const result = buildMessageHistoryTree(tree, new Set(["1"]));
		expect(result.items[0]!.estimatedTokens).toBeGreaterThan(0);
		const labels = result.items[0]!.children!.map((item) => item.label);
		expect(labels.some((label) => label.includes("thinking") && label.includes("char/4"))).toBe(true);
		expect(labels.some((label) => label.includes("tool call read arguments") && label.includes("char/4"))).toBe(true);
	});

	it("shows the exact provider-reported aggregate request context on assistant turns without calling it a per-item cost", () => {
		const result = buildMessageHistoryTree(
			[
				node("1", {
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer" }],
						usage: { input: 200, cacheRead: 300, cacheWrite: 50 },
					},
				}),
			],
			new Set(["1"]),
		);
		expect(result.items[0]!.label).toContain("provider-reported request context 550 tok");
		expect(result.items[0]!.label).toContain("new 200, cache read 300, write 50");
	});

	it("surfaces image presence while stating that its provider-specific token cost is unavailable", () => {
		const result = buildMessageHistoryTree(
			[
				node("1", {
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "inspect" },
							{ type: "image", data: "base64" },
						],
					},
				}),
			],
			new Set(["1"]),
		);
		expect(result.items[0]!.label).toContain("1 image (token cost unavailable)");
	});

	it("excludes bashExecution output explicitly marked excludeFromContext, matching Pi's own !! prefix behavior", () => {
		const included = buildMessageHistoryTree(
			[
				node("1", {
					type: "message",
					message: { role: "bashExecution", command: "ls", output: "x".repeat(100), excludeFromContext: false },
				}),
			],
			new Set(["1"]),
		);
		const excluded = buildMessageHistoryTree(
			[
				node("2", {
					type: "message",
					message: { role: "bashExecution", command: "ls", output: "x".repeat(100), excludeFromContext: true },
				}),
			],
			new Set(["2"]),
		);
		expect(included.items).toHaveLength(1);
		expect(excluded.items).toHaveLength(0);
	});

	it("counts compaction and branch_summary entries' summaries, since they do participate in context", () => {
		const tree = [
			node("1", { type: "compaction", summary: "x".repeat(400) }),
			node("2", { type: "branch_summary", summary: "y".repeat(400) }),
		];
		const result = buildMessageHistoryTree(tree, new Set(["1", "2"]));
		expect(result.activeTokens).toBe(Math.ceil(800 / 4));
	});

	it("drops non-context entry types that have no content and no descendants", () => {
		const tree = [node("1", { type: "custom" }), node("2", { type: "label" }), node("3", { type: "model_change" })];
		expect(buildMessageHistoryTree(tree, new Set()).items).toEqual([]);
	});

	it("returns an empty tree for no roots rather than throwing", () => {
		expect(buildMessageHistoryTree([], new Set())).toEqual({ items: [], activeTokens: 0, truncated: false });
	});

	it("tolerates a malformed or unexpected message shape without throwing", () => {
		const tree = [
			node("1", { type: "message", message: null }),
			node("2", { type: "message", message: "not an object" as unknown as undefined }),
		];
		expect(() => buildMessageHistoryTree(tree, new Set())).not.toThrow();
	});

	it("is cycle-safe: a node that (incorrectly) appears as its own descendant is not revisited, and truncated is reported", () => {
		const cyclic: SessionTreeNodeLike = node("1", { type: "message", message: { role: "user", content: "x" } });
		cyclic.children.push(cyclic);
		const result = buildMessageHistoryTree([cyclic], new Set(["1"]));
		expect(result.truncated).toBe(true);
		expect(result.items).toHaveLength(1);
	});
});

describe("buildBasePromptItems", () => {
	it("splits tool snippets, skills, and context files into their own items, each with a real count", () => {
		const items = buildBasePromptItems(
			{
				cwd: "/workspace",
				toolSnippets: { read: "Read the contents of a file.", bash: "Execute a bash command." },
				skills: [
					{
						name: "commit",
						description: "Write commits.",
						filePath: "/skills/commit/SKILL.md",
						baseDir: "/skills/commit",
						sourceInfo: {} as never,
						disableModelInvocation: false,
					},
				],
				contextFiles: [{ path: "/workspace/AGENTS.md", content: "Some project instructions." }],
			},
			5000,
		);
		const labels = items.map((item) => item.label);
		expect(labels.some((label) => label.includes("Tool snippets (2 tools)"))).toBe(true);
		expect(labels.some((label) => label.includes("Skills catalog (1 skills)"))).toBe(true);
		expect(labels.some((label) => label.includes("Project context files (1"))).toBe(true);
		expect(labels.some((label) => label.includes("Base template"))).toBe(true);
		for (const item of items) expect(item.estimatedTokens).toBeGreaterThan(0);
		expect(items.find((item) => item.label.includes("Tool snippets"))!.children!.map((item) => item.label)).toEqual(
			expect.arrayContaining([expect.stringContaining("read"), expect.stringContaining("bash")]),
		);
		expect(items.find((item) => item.label.includes("Skills catalog"))!.children![0]!.label).toContain("commit");
		expect(items.find((item) => item.label.includes("Project context files"))!.children![0]!.label).toContain("AGENTS.md");
	});

	it("excludes skills marked disableModelInvocation from the count, since Pi's own formatSkillsForPrompt does the same", () => {
		const items = buildBasePromptItems(
			{
				cwd: "/workspace",
				skills: [
					{ name: "visible", description: "d", filePath: "/f", baseDir: "/", sourceInfo: {} as never, disableModelInvocation: false },
					{ name: "hidden", description: "d", filePath: "/f", baseDir: "/", sourceInfo: {} as never, disableModelInvocation: true },
				],
			},
			5000,
		);
		const skillsItem = items.find((item) => item.label.includes("Skills catalog"))!;
		expect(skillsItem.label).toContain("(1 skills)");
	});

	it("the remainder (base template) absorbs whatever the known sub-segments don't attribute, matching the real total honestly", () => {
		const items = buildBasePromptItems({ cwd: "/workspace" }, 4000);
		expect(items).toHaveLength(1);
		expect(items[0]!.label).toBe("Base template, guidelines, and formatting");
		expect(items[0]!.estimatedTokens).toBe(Math.ceil(4000 / 4));
	});

	it("returns only the base-template item when no structural options are present at all", () => {
		const items = buildBasePromptItems({ cwd: "/workspace" }, 0);
		expect(items).toHaveLength(1);
		expect(items[0]!.estimatedTokens).toBe(0);
	});
});

describe("basePromptSegment / messageHistorySegment", () => {
	it("marks basePrompt unknown before the first observed turn, distinct from measured-and-empty", () => {
		const unobserved = basePromptSegment(null, []);
		expect(unobserved.unknown).toBe(true);
		expect(unobserved.label).toContain("not observed yet");
		const observed = basePromptSegment(500, [{ label: "Tool snippets", estimatedTokens: 120 }]);
		expect(observed.unknown).toBeUndefined();
		expect(observed.estimatedTokens).toBe(500);
		expect(observed.items).toHaveLength(1);
	});

	it("uses only the active-path token sum for messageHistory's own total, even though items include inactive branches", () => {
		const tree = buildMessageHistoryTree(
			[
				node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } }, [
					node("2b", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(400) }] } }),
				]),
			],
			new Set(["1"]),
		);
		const segment = messageHistorySegment(tree);
		expect(segment.estimatedTokens).toBe(Math.ceil(40 / 4)); // excludes the inactive branch's 400 chars
		expect(segment.items).toBeDefined();
	});
});

describe("composeContextBreakdown", () => {
	function segment(key: string, estimatedTokens: number): ContextSegment {
		return { key, label: key, estimatedTokens, confidence: "correlated" };
	}

	it("derives 'other' as the remainder between the real total and every known segment", () => {
		const breakdown = composeContextBreakdown({
			totalTokens: 1000,
			contextWindow: 200_000,
			segments: [segment("rules", 100), segment("tasks", 20), segment("skills", 50)],
		});
		const other = breakdown.segments.find((s) => s.key === "other")!;
		expect(other.estimatedTokens).toBe(1000 - 170);
		expect(breakdown.overshootTokens).toBe(0);
	});

	it("clamps 'other' to zero instead of going negative when estimates overshoot the real total, preserving the overshoot amount", () => {
		const breakdown = composeContextBreakdown({
			totalTokens: 50,
			contextWindow: null,
			segments: [segment("rules", 100), segment("tasks", 20), segment("skills", 50)],
		});
		const other = breakdown.segments.find((s) => s.key === "other")!;
		expect(other.estimatedTokens).toBe(0);
		expect(breakdown.overshootTokens).toBe(120);
		expect(other.label).toContain("estimate overshoot");
		expect(other.label).toContain("120 tokens");
	});

	it("does not mention overshoot in the label when there isn't one", () => {
		const breakdown = composeContextBreakdown({ totalTokens: 1000, contextWindow: null, segments: [segment("rules", 100)] });
		expect(breakdown.segments.find((s) => s.key === "other")!.label).not.toContain("overshoot");
	});

	it("reports zero for 'other' and preserves null totalTokens when real usage is unavailable", () => {
		const breakdown = composeContextBreakdown({ totalTokens: null, contextWindow: null, segments: [segment("rules", 100)] });
		expect(breakdown.totalTokens).toBeNull();
		expect(breakdown.segments.find((s) => s.key === "other")!.estimatedTokens).toBe(0);
		expect(breakdown.overshootTokens).toBe(0);
	});

	it("computes effectiveBudget as contextWindow minus the default reserve", () => {
		const breakdown = composeContextBreakdown({ totalTokens: 1000, contextWindow: 200_000, segments: [] });
		expect(breakdown.effectiveBudget).toBe(200_000 - 16_384);
	});

	it("honors an explicit reserveTokens override instead of the default", () => {
		const breakdown = composeContextBreakdown({ totalTokens: 1000, contextWindow: 100_000, reserveTokens: 5000, segments: [] });
		expect(breakdown.effectiveBudget).toBe(95_000);
	});

	it("reports effectiveBudget as null when the context window itself is unknown", () => {
		expect(composeContextBreakdown({ totalTokens: 1000, contextWindow: null, segments: [] }).effectiveBudget).toBeNull();
	});

	it("preserves input segment order and appends 'other' last", () => {
		const breakdown = composeContextBreakdown({ totalTokens: 1000, contextWindow: null, segments: [segment("b", 10), segment("a", 20)] });
		expect(breakdown.segments.map((s) => s.key)).toEqual(["b", "a", "other"]);
	});
});
