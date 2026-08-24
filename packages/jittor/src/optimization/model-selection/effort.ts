import {
	EFFORT_CLASSIFICATION_MAX_TEXT_CHARACTERS,
	EFFORT_CLASSIFICATION_MAX_TOOL_NAMES,
	EFFORT_DIMENSION_WEIGHT_CODE_PRESENCE,
	EFFORT_DIMENSION_WEIGHT_MULTI_STEP_PATTERNS,
	EFFORT_DIMENSION_WEIGHT_QUESTION_COMPLEXITY,
	EFFORT_DIMENSION_WEIGHT_REASONING_MARKERS,
	EFFORT_DIMENSION_WEIGHT_SIMPLE_INDICATORS,
	EFFORT_DIMENSION_WEIGHT_TECHNICAL_TERMS,
	EFFORT_DIMENSION_WEIGHT_TOKEN_COUNT,
	EFFORT_DIMENSION_WEIGHT_TOOL_CALL_MIX,
	EFFORT_LOW_MEDIUM_BOUNDARY,
	EFFORT_MEDIUM_HIGH_BOUNDARY,
	EFFORT_REASONING_MARKER_OVERRIDE_COUNT,
	EFFORT_TOKEN_COMPLEX_THRESHOLD,
	EFFORT_TOKEN_SIMPLE_THRESHOLD,
	EFFORT_TOOL_CALL_HIGH_THRESHOLD,
	EFFORT_TOOL_CALL_LOW_THRESHOLD,
} from "../../constants.ts";
import type { ModelTaskEffort } from "../../observability/model-observation.ts";

/**
 * Structural/lexical effort classifier -- zero network calls, no persisted prompt content,
 * deterministic, bounded, sub-millisecond. Modeled on LiteLLM's real merged `complexity_router`
 * (word-boundary keyword matching, non-greedy ReDoS-safe multi-step regex, a reasoning-marker
 * override), with two deliberate departures recorded here rather than silently made:
 *
 * 1. Only the user's own current-turn message and the prior turn's tool-call mix are scored --
 *    never Pi's own system prompt. LiteLLM's design assumes a short, custom system prompt; Pi's
 *    real system prompt is a large, fixed agent-harness prompt full of tool descriptions that
 *    would permanently saturate the code/technical dimensions if scanned. Scoring only the
 *    user's own fresh text avoids that false-signal-forever failure mode.
 * 2. Token count uses a plain char/4 structural estimate by default (matching
 *    CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN elsewhere in this codebase), not a real tokenizer --
 *    a real per-provider tokenizer is a replaceable integration per this project's own
 *    architecture, not something a turn-boundary classifier should hard-depend on. Pass
 *    `estimateTokens` to plug in a better one without changing this module's contract.
 */

export interface EffortClassificationInput {
	/** The current turn's own user message. Never retained beyond this call. */
	userText: string;
	/** Tool names actually called during the immediately preceding turn, if any. */
	priorTurnToolNames?: string[];
}

export interface EffortClassifierOptions {
	/** Overrides the default char/4 structural estimate, e.g. with a real per-provider tokenizer. */
	estimateTokens?: (text: string) => number;
}

export interface EffortClassification {
	effort: ModelTaskEffort;
	/** The raw weighted score before tier-boundary mapping; not itself bounded to 0..1 (an override can exceed it). */
	score: number;
	/** Human-readable evidence, one entry per dimension that actually contributed -- never a bare label with no reasoning. Never contains the raw input text. */
	signals: string[];
	/** True when the reasoning-marker override forced "high" regardless of the weighted score. */
	override: boolean;
}

interface DimensionScore {
	name: string;
	score: number;
	weight: number;
	evidence: string | null;
}

// Single-word keywords use word-boundary matching (avoids "api" matching "capital", "class"
// matching "classical"); multi-word phrases use substring matching. Mirrors LiteLLM's own
// complexity_router keyword-matching technique, verified against its real merged source.
const CODE_KEYWORDS = [
	"function",
	"class",
	"async",
	"await",
	"import",
	"export",
	"api",
	"endpoint",
	"database",
	"query",
	"schema",
	"algorithm",
	"refactor",
	"debug",
	"python",
	"typescript",
	"javascript",
	"docker",
	"kubernetes",
	"git",
	"regex",
];
const REASONING_KEYWORDS = [
	"step by step",
	"think through",
	"reason through",
	"analyze this",
	"break down",
	"break it down",
	"explain your reasoning",
	"show your work",
	"chain of thought",
	"think carefully",
	"weigh the options",
	"root cause",
];
const TECHNICAL_KEYWORDS = [
	"architecture",
	"distributed",
	"scalable",
	"microservice",
	"encryption",
	"authentication",
	"authorization",
	"performance",
	"latency",
	"throughput",
	"concurrency",
	"orchestration",
	"protocol",
];
const SIMPLE_KEYWORDS = [
	"what is",
	"what's",
	"define",
	"who is",
	"who was",
	"when did",
	"when was",
	"how many",
	"hello",
	"hi",
	"thanks",
	"thank you",
];

const MULTI_STEP_PATTERNS = [/first.*?then/i, /step\s*\d/i, /\d+\.\s/, /[a-z]\)\s/i];

function boundedText(value: string): string {
	return value.slice(0, EFFORT_CLASSIFICATION_MAX_TEXT_CHARACTERS);
}

function wordBoundaryOrSubstringMatches(text: string, keyword: string): boolean {
	if (!keyword.includes(" ")) return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
	return text.includes(keyword);
}

function countMatches(text: string, keywords: string[]): { count: number; matched: string[] } {
	const matched = keywords.filter((keyword) => wordBoundaryOrSubstringMatches(text, keyword));
	return { count: matched.length, matched };
}

function estimateTokensStructural(text: string): number {
	return Math.ceil(text.length / 4);
}

function scoreTokenCount(tokens: number): DimensionScore {
	if (tokens < EFFORT_TOKEN_SIMPLE_THRESHOLD)
		return {
			name: "tokenCount",
			score: -1,
			weight: EFFORT_DIMENSION_WEIGHT_TOKEN_COUNT,
			evidence: `short user message (${tokens} est. tokens)`,
		};
	if (tokens > EFFORT_TOKEN_COMPLEX_THRESHOLD)
		return {
			name: "tokenCount",
			score: 1,
			weight: EFFORT_DIMENSION_WEIGHT_TOKEN_COUNT,
			evidence: `long user message (${tokens} est. tokens)`,
		};
	return { name: "tokenCount", score: 0, weight: EFFORT_DIMENSION_WEIGHT_TOKEN_COUNT, evidence: null };
}

function scoreKeywordDimension(
	text: string,
	keywords: string[],
	name: string,
	weight: number,
	direction: 1 | -1,
	label: string,
): { dimension: DimensionScore; count: number } {
	const { count, matched } = countMatches(text, keywords);
	const score = count === 0 ? 0 : count === 1 ? 0.5 * direction : 1 * direction;
	return {
		dimension: { name, score, weight, evidence: count === 0 ? null : `${label} (${matched.slice(0, 3).join(", ")})` },
		count,
	};
}

function scoreMultiStep(text: string): DimensionScore {
	const hit = MULTI_STEP_PATTERNS.some((pattern) => pattern.test(text));
	return {
		name: "multiStepPatterns",
		score: hit ? 1 : 0,
		weight: EFFORT_DIMENSION_WEIGHT_MULTI_STEP_PATTERNS,
		evidence: hit ? "multi-step structure detected" : null,
	};
}

function scoreQuestionComplexity(text: string): DimensionScore {
	const count = (text.match(/\?/g) ?? []).length;
	return {
		name: "questionComplexity",
		score: count > 3 ? 1 : 0,
		weight: EFFORT_DIMENSION_WEIGHT_QUESTION_COMPLEXITY,
		evidence: count > 3 ? `${count} questions in one message` : null,
	};
}

/**
 * Prior-turn tool-call volume as an effort signal: sustained multi-tool engineering work (several
 * distinct tool calls last turn) is real evidence of an in-progress complex task; zero or one
 * tool call is evidence of a light, simple exchange. Bounded, structural, content-free --
 * tool names only, never their arguments or results.
 */
function scoreToolCallMix(toolNames: string[]): DimensionScore {
	const distinct = new Set(toolNames.slice(0, EFFORT_CLASSIFICATION_MAX_TOOL_NAMES).map((name) => name.toLowerCase()));
	if (distinct.size <= EFFORT_TOOL_CALL_LOW_THRESHOLD)
		return {
			name: "toolCallMix",
			score: -1,
			weight: EFFORT_DIMENSION_WEIGHT_TOOL_CALL_MIX,
			evidence: distinct.size === 0 ? "no prior tool activity" : "single prior tool call",
		};
	if (distinct.size >= EFFORT_TOOL_CALL_HIGH_THRESHOLD)
		return {
			name: "toolCallMix",
			score: 1,
			weight: EFFORT_DIMENSION_WEIGHT_TOOL_CALL_MIX,
			evidence: `${distinct.size} distinct tools used last turn`,
		};
	return { name: "toolCallMix", score: 0, weight: EFFORT_DIMENSION_WEIGHT_TOOL_CALL_MIX, evidence: null };
}

function tierFor(score: number): ModelTaskEffort {
	if (score < EFFORT_LOW_MEDIUM_BOUNDARY) return "low";
	if (score < EFFORT_MEDIUM_HIGH_BOUNDARY) return "medium";
	return "high";
}

export function classifyEffort(input: EffortClassificationInput, options: EffortClassifierOptions = {}): EffortClassification {
	const userText = boundedText(typeof input.userText === "string" ? input.userText : "");
	const toolNames = Array.isArray(input.priorTurnToolNames) ? input.priorTurnToolNames : [];
	const estimateTokens = options.estimateTokens ?? estimateTokensStructural;

	const code = scoreKeywordDimension(
		userText,
		CODE_KEYWORDS,
		"codePresence",
		EFFORT_DIMENSION_WEIGHT_CODE_PRESENCE,
		1,
		"code-related terms",
	);
	const reasoning = scoreKeywordDimension(
		userText,
		REASONING_KEYWORDS,
		"reasoningMarkers",
		EFFORT_DIMENSION_WEIGHT_REASONING_MARKERS,
		1,
		"reasoning markers",
	);
	const technical = scoreKeywordDimension(
		userText,
		TECHNICAL_KEYWORDS,
		"technicalTerms",
		EFFORT_DIMENSION_WEIGHT_TECHNICAL_TERMS,
		1,
		"technical terms",
	);
	const simple = scoreKeywordDimension(
		userText,
		SIMPLE_KEYWORDS,
		"simpleIndicators",
		EFFORT_DIMENSION_WEIGHT_SIMPLE_INDICATORS,
		-1,
		"simple-query phrasing",
	);

	const dimensions: DimensionScore[] = [
		scoreTokenCount(estimateTokens(userText)),
		code.dimension,
		reasoning.dimension,
		technical.dimension,
		simple.dimension,
		scoreMultiStep(userText),
		scoreQuestionComplexity(userText),
		scoreToolCallMix(toolNames),
	];

	const score = dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0);
	const signals = dimensions.filter((dimension) => dimension.evidence !== null).map((dimension) => dimension.evidence as string);
	const override = reasoning.count >= EFFORT_REASONING_MARKER_OVERRIDE_COUNT;

	return {
		effort: override ? "high" : tierFor(score),
		score,
		signals,
		override,
	};
}
