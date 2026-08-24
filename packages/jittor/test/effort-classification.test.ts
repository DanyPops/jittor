import { describe, expect, it } from "bun:test";
import type { ModelTaskEffort } from "../src/observability/model-observation.ts";
import { classifyEffort, type EffortClassification } from "../src/optimization/model-selection/effort.ts";

interface EffortEvalCase {
	description: string;
	userText: string;
	priorTurnToolNames?: string[];
	expected: ModelTaskEffort;
	/** Some prompts are genuinely borderline; an acceptable band avoids a brittle exact-tier assertion, mirroring LiteLLM's own eval-case shape. */
	acceptable?: ModelTaskEffort[];
}

const EVAL_CASES: EffortEvalCase[] = [
	{ description: "bare greeting", userText: "Hello!", expected: "low" },
	{ description: "single word", userText: "Yes", expected: "low" },
	{ description: "simple definition question", userText: "What is Python?", expected: "low" },
	{ description: "simple factual question", userText: "Who is Ada Lovelace?", expected: "low" },
	{ description: "thanks", userText: "Thanks for your help!", expected: "low" },
	{
		description: "moderate explanation request",
		userText: "Explain how REST APIs work and when to use them",
		expected: "medium",
		acceptable: ["low", "medium"],
	},
	{
		description: "technical comparison request with moderate prior tool activity",
		userText:
			"Compare the SQL versus NoSQL database architecture trade-offs for this project, considering query performance and schema flexibility",
		priorTurnToolNames: ["read", "grep", "edit"],
		expected: "medium",
		acceptable: ["medium", "high"],
	},
	{
		description: "long multi-part engineering request with sustained tool activity",
		userText:
			"Design a distributed microservice architecture for a high-throughput real-time data processing pipeline with Kubernetes orchestration, implementing proper authentication and encryption protocols across every service boundary",
		priorTurnToolNames: ["read", "grep", "edit", "bash", "find"],
		expected: "high",
		acceptable: ["medium", "high"],
	},
	{
		description: "explicit reasoning override regardless of otherwise short text",
		userText: "Think step by step and analyze this carefully before you answer.",
		expected: "high",
	},
];

describe("effort classification", () => {
	for (const testCase of EVAL_CASES) {
		it(`classifies "${testCase.description}" as ${testCase.acceptable?.join("/") ?? testCase.expected}`, () => {
			const result = classifyEffort({ userText: testCase.userText, priorTurnToolNames: testCase.priorTurnToolNames });
			expect(testCase.acceptable ?? [testCase.expected]).toContain(result.effort);
		});
	}

	it("returns a trace of the evidence that produced the classification, never a bare label", () => {
		const result = classifyEffort({ userText: "Think step by step and analyze this carefully before you answer." });
		expect(result.signals.length).toBeGreaterThan(0);
		expect(result.signals.join(" ")).toMatch(/reason/i);
	});

	it("avoids single-word false positives via word-boundary matching", () => {
		// "capital" must not match the "api" code keyword; "classical" must not match "class".
		const result = classifyEffort({ userText: "What is the capital of France? I love classical music." });
		expect(result.effort).toBe("low");
	});

	it("triggers the reasoning override at 2+ marker phrases regardless of the weighted score", () => {
		const result: EffortClassification = classifyEffort({
			userText: "Think through this step by step, and explain your reasoning.",
		});
		expect(result.effort).toBe("high");
		expect(result.override).toBe(true);
	});

	it("does not trigger the reasoning override on a single marker phrase alone", () => {
		const result = classifyEffort({ userText: "Can you think through this quickly?" });
		expect(result.override).toBe(false);
	});

	it("is deterministic for identical input", () => {
		const input = { userText: "Refactor this function to improve performance.", priorTurnToolNames: ["edit", "bash"] };
		expect(classifyEffort(input)).toEqual(classifyEffort(input));
	});

	it("stays bounded and fast on a pathological repeated-pattern input (ReDoS safety)", () => {
		const pathological = `${"a ".repeat(20_000)}first then first then first then`;
		const startedAt = performance.now();
		classifyEffort({ userText: pathological });
		expect(performance.now() - startedAt).toBeLessThan(200);
	});

	it("bounds oversized input rather than scanning it unbounded", () => {
		const huge = "x".repeat(1_000_000);
		expect(() => classifyEffort({ userText: huge })).not.toThrow();
	});

	it("increases effort with sustained multi-tool prior-turn activity, all else equal", () => {
		const withoutTools = classifyEffort({ userText: "Update the config" });
		const withManyTools = classifyEffort({ userText: "Update the config", priorTurnToolNames: ["read", "grep", "edit", "bash", "find"] });
		expect(withManyTools.score).toBeGreaterThan(withoutTools.score);
	});

	it("never persists or echoes back the raw input text itself in signals (structural evidence only)", () => {
		const secretLookingText = "sk-my-secret-token-should-not-appear-verbatim-anywhere";
		const result = classifyEffort({ userText: secretLookingText });
		expect(result.signals.join(" ")).not.toContain(secretLookingText);
	});
});
