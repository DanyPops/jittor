import { describe, expect, it } from "bun:test";
import {
	countTextWithFallback,
	loadOpenAiTextTokenCounter,
	reconcileRequestTokens,
	StructuralTextTokenCounter,
	type TextTokenCounter,
	validateRequestTokenReconciliation,
	validateTokenMeasurement,
} from "../src/index.ts";

describe("token measurement provenance", () => {
	it("validates a stable, bounded serialized measurement shape", () => {
		expect(
			validateTokenMeasurement({
				tokens: 3,
				scope: "context-item",
				provenance: "tokenizer-exact-text",
				method: "gpt-tokenizer:o200k_base",
				provider: "openai",
				model: "gpt-5",
			}),
		).toEqual({
			tokens: 3,
			scope: "context-item",
			provenance: "tokenizer-exact-text",
			method: "gpt-tokenizer:o200k_base",
			provider: "openai",
			model: "gpt-5",
		});
		expect(() =>
			validateTokenMeasurement({ tokens: -1, scope: "context-item", provenance: "structural-estimate", method: "char/4" }),
		).toThrow("tokens");
		expect(() =>
			validateTokenMeasurement({
				tokens: 1,
				scope: "context-item",
				provenance: "structural-estimate",
				method: "char/4",
				content: "must never be serialized",
			}),
		).toThrow("unsupported field");
		expect(() =>
			validateTokenMeasurement({
				tokens: 1,
				scope: "context-item",
				provenance: "structural-estimate",
				method: "char/4",
				provider: 123,
				model: "gpt-5",
			}),
		).toThrow("identity");
	});

	it("uses a model-aware counter when supported and visibly falls back to char/4 otherwise", () => {
		const exact: TextTokenCounter = {
			countText(input) {
				if (input.provider !== "openai" || input.model !== "gpt-5") return null;
				return {
					tokens: 2,
					scope: input.scope,
					provenance: "tokenizer-exact-text",
					method: "fixture:o200k_base",
					provider: input.provider,
					model: input.model,
				};
			},
		};
		const fallback = new StructuralTextTokenCounter();

		expect(
			countTextWithFallback({ text: "hello", provider: "openai", model: "gpt-5", scope: "context-item" }, [exact], fallback),
		).toMatchObject({
			tokens: 2,
			provenance: "tokenizer-exact-text",
		});
		expect(
			countTextWithFallback({ text: "abcdefgh", provider: "unknown", model: "new-model", scope: "context-item" }, [exact], fallback),
		).toEqual({
			tokens: 2,
			scope: "context-item",
			provenance: "structural-estimate",
			method: "char/4",
			provider: "unknown",
			model: "new-model",
		});
	});

	it("counts supported OpenAI-family text with the model encoding and declines unknown models", async () => {
		const modern = await loadOpenAiTextTokenCounter("openai", "gpt-5");
		const legacy = await loadOpenAiTextTokenCounter("openai", "gpt-4");
		expect(modern?.countText({ text: "hello world", provider: "openai", model: "gpt-5", scope: "context-item" })).toEqual({
			tokens: 2,
			scope: "context-item",
			provenance: "tokenizer-exact-text",
			method: "gpt-tokenizer:o200k_base",
			provider: "openai",
			model: "gpt-5",
		});
		expect(legacy?.countText({ text: "hello world", provider: "openai", model: "gpt-4", scope: "context-item" })).toMatchObject({
			tokens: 2,
			method: "gpt-tokenizer:cl100k_base",
		});
		expect(
			modern?.countText({ text: "Hello 👋 世界 — café", provider: "openrouter", model: "openai/gpt-4.1", scope: "context-item" }),
		).toMatchObject({
			provenance: "tokenizer-exact-text",
			provider: "openrouter",
			model: "openai/gpt-4.1",
		});
		expect(modern?.countText({ text: "hello", provider: "anthropic", model: "claude-sonnet-4", scope: "context-item" })).toBeNull();
		expect(await loadOpenAiTextTokenCounter("openai", "future-unknown")).toBeNull();
	});

	it("conforms across prose, tool JSON, high-entropy text, and Unicode without serializing the source", async () => {
		const counter = await loadOpenAiTextTokenCounter("openai", "gpt-5");
		if (!counter) throw new Error("expected the gpt-5 tokenizer fixture to be available");
		const fixtures = [
			"plain English prose with repeated words",
			JSON.stringify({ name: "read", arguments: { path: "src/observability/token-measurement.ts" } }),
			"8f14e45fceea167a5a36dedd4bea2543a1d0c6e83f027327d8461063f4ac58a6",
			"Hello 👋 世界 — café Ελληνικά العربية हिन्दी",
		];
		for (const text of fixtures) {
			const first = counter.countText({ text, provider: "openai", model: "gpt-5", scope: "context-item" });
			const second = counter.countText({ text, provider: "openai", model: "gpt-5", scope: "context-item" });
			expect(first?.tokens).toBeGreaterThan(0);
			expect(second).toEqual(first);
			expect(JSON.stringify(first)).not.toContain(text);
		}
	});

	it("keeps the provider aggregate authoritative and returns an explicit residual instead of assigning it to items", () => {
		const result = reconcileRequestTokens(
			{
				tokens: 550,
				scope: "request-context",
				provenance: "provider-reported",
				method: "pi-assistant-usage",
				provider: "openai",
				model: "gpt-5",
			},
			[
				{
					tokens: 100,
					scope: "context-item",
					provenance: "tokenizer-exact-text",
					method: "fixture:o200k_base",
					provider: "openai",
					model: "gpt-5",
				},
				{ tokens: 200, scope: "context-item", provenance: "structural-estimate", method: "char/4", provider: "openai", model: "gpt-5" },
			],
		);

		expect(result.aggregate.tokens).toBe(550);
		expect(result.attributedTokens).toBe(300);
		expect(result.residual).toEqual({
			tokens: 250,
			scope: "unattributed-residual",
			provenance: "structural-estimate",
			method: "aggregate-minus-attributed",
			provider: "openai",
			model: "gpt-5",
		});
		expect(result.overshootTokens).toBe(0);
		expect(() =>
			validateRequestTokenReconciliation({
				...result,
				residual: { ...result.residual, provider: "anthropic", model: "claude-sonnet-4" },
			}),
		).toThrow("identity");
	});

	it("reports attribution overshoot without making the provider aggregate larger", () => {
		const result = reconcileRequestTokens(
			{ tokens: 10, scope: "request-context", provenance: "provider-reported", method: "pi-assistant-usage" },
			[{ tokens: 12, scope: "context-item", provenance: "structural-estimate", method: "char/4" }],
		);
		expect(result.aggregate.tokens).toBe(10);
		expect(result.residual.tokens).toBe(0);
		expect(result.overshootTokens).toBe(2);
	});
});
