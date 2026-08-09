import { normalizeModelIdentity } from "../observability/model-identity.ts";
import type { TextTokenCounter, TextTokenCountInput, TokenMeasurement } from "../observability/token-measurement.ts";

type OpenAiEncoding = "cl100k_base" | "o200k_base" | "o200k_harmony";
type EncodeText = (text: string) => ArrayLike<number>;

function openAiModelId(provider: string | undefined, model: string | undefined): string | null {
	if (provider === undefined || model === undefined) return null;
	const normalizedProvider = provider.toLowerCase();
	const normalizedModel = model.toLowerCase();
	if (["openai", "openai-codex", "azure-openai"].includes(normalizedProvider)) return normalizedModel;
	if (normalizedProvider === "openrouter" && normalizedModel.startsWith("openai/")) return normalizedModel.slice("openai/".length);
	return null;
}

/** Deliberately conservative: an unknown future model falls back instead of guessing an encoding and claiming exact text tokenization. */
function encodingForOpenAiModel(model: string): OpenAiEncoding | null {
	if (model.startsWith("gpt-oss-")) return "o200k_harmony";
	if (/^(?:gpt-5|gpt-4\.1|gpt-4o|chatgpt-4o|o[134](?:-|$))/.test(model)) return "o200k_base";
	if (/^(?:gpt-4(?:-|$)|gpt-3\.5(?:-|$)|text-embedding-(?:3|ada-002))/.test(model)) return "cl100k_base";
	return null;
}

/**
 * Exact BPE count for the supplied text only. It intentionally does not encode a provider request
 * envelope, tools, images, cache controls, or chat template, so its provenance is never presented
 * as exact request usage.
 */
export class OpenAiTextTokenCounter implements TextTokenCounter {
	constructor(
		private readonly encoding: OpenAiEncoding,
		private readonly encode: EncodeText,
	) {}

	countText(input: TextTokenCountInput): TokenMeasurement | null {
		const modelId = openAiModelId(input.provider, input.model);
		if (!modelId || encodingForOpenAiModel(modelId) !== this.encoding) return null;
		const identity = normalizeModelIdentity(input.provider!, input.model!);
		return {
			tokens: this.encode(input.text).length,
			scope: input.scope,
			provenance: "tokenizer-exact-text",
			method: `gpt-tokenizer:${this.encoding}`,
			provider: identity.provider,
			model: identity.model,
		};
	}
}

/** Loads only the one BPE table required by the requested model, and returns null rather than guessing for an unknown mapping. */
export async function loadOpenAiTextTokenCounter(provider: string, model: string): Promise<OpenAiTextTokenCounter | null> {
	const modelId = openAiModelId(provider, model);
	if (!modelId) return null;
	const encoding = encodingForOpenAiModel(modelId);
	if (!encoding) return null;
	const module =
		encoding === "o200k_base"
			? await import("gpt-tokenizer/encoding/o200k_base")
			: encoding === "o200k_harmony"
				? await import("gpt-tokenizer/encoding/o200k_harmony")
				: await import("gpt-tokenizer/encoding/cl100k_base");
	return new OpenAiTextTokenCounter(encoding, module.encode);
}
