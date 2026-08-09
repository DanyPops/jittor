import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN } from "../constants.ts";
import { normalizeModelIdentity } from "./model-identity.ts";

export const TOKEN_MEASUREMENT_PROVENANCES = [
	"provider-reported",
	"provider-count-api",
	"tokenizer-exact-text",
	"structural-estimate",
] as const;
export type TokenMeasurementProvenance = (typeof TOKEN_MEASUREMENT_PROVENANCES)[number];

export const TOKEN_MEASUREMENT_SCOPES = [
	"request-context",
	"request-input",
	"response-output",
	"cache-read",
	"cache-write",
	"context-item",
	"unattributed-residual",
] as const;
export type TokenMeasurementScope = (typeof TOKEN_MEASUREMENT_SCOPES)[number];

export interface TokenMeasurement {
	tokens: number;
	scope: TokenMeasurementScope;
	provenance: TokenMeasurementProvenance;
	/** Bounded implementation/counting identity, never content (for example `char/4` or `gpt-tokenizer:o200k_base`). */
	method: string;
	provider?: string;
	model?: string;
}

const TOKEN_MEASUREMENT_FIELDS = new Set<keyof TokenMeasurement>(["tokens", "scope", "provenance", "method", "provider", "model"]);
const TOKEN_MEASUREMENT_METHOD_MAX_CHARACTERS = 120;

function boundedMethod(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > TOKEN_MEASUREMENT_METHOD_MAX_CHARACTERS || /\p{Cc}/u.test(value))
		throw new Error("token measurement method is invalid");
	return value;
}

export function validateTokenMeasurement(value: unknown): TokenMeasurement {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("token measurement must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!TOKEN_MEASUREMENT_FIELDS.has(key as keyof TokenMeasurement)) throw new Error(`unsupported field: ${key}`);
	}
	if (typeof input.tokens !== "number" || !Number.isSafeInteger(input.tokens) || input.tokens < 0)
		throw new Error("token measurement tokens are invalid");
	if (!TOKEN_MEASUREMENT_SCOPES.includes(input.scope as TokenMeasurementScope)) throw new Error("token measurement scope is invalid");
	if (!TOKEN_MEASUREMENT_PROVENANCES.includes(input.provenance as TokenMeasurementProvenance))
		throw new Error("token measurement provenance is invalid");
	if ((input.provider === undefined) !== (input.model === undefined))
		throw new Error("token measurement provider/model identity is incomplete");
	if (
		(input.provider !== undefined && typeof input.provider !== "string") ||
		(input.model !== undefined && typeof input.model !== "string")
	)
		throw new Error("token measurement provider/model identity is invalid");
	const identity =
		input.provider === undefined || input.model === undefined ? undefined : normalizeModelIdentity(input.provider, input.model);
	return {
		tokens: input.tokens,
		scope: input.scope as TokenMeasurementScope,
		provenance: input.provenance as TokenMeasurementProvenance,
		method: boundedMethod(input.method),
		...(identity ? { provider: identity.provider, model: identity.model } : {}),
	};
}

export interface TextTokenCountInput {
	/** Ephemeral input. Implementations must not retain or include it in diagnostics/measurements. */
	text: string;
	provider?: string;
	model?: string;
	scope: "context-item" | "request-input" | "response-output";
}

/** A replaceable, content-ephemeral text counting boundary. Unsupported provider/model identities return null. */
export interface TextTokenCounter {
	countText(input: TextTokenCountInput): TokenMeasurement | null;
}

export class StructuralTextTokenCounter implements TextTokenCounter {
	countText(input: TextTokenCountInput): TokenMeasurement {
		const identity =
			input.provider === undefined || input.model === undefined ? undefined : normalizeModelIdentity(input.provider, input.model);
		return {
			tokens: Math.ceil(input.text.length / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN),
			scope: input.scope,
			provenance: "structural-estimate",
			method: `char/${CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN}`,
			...(identity ? { provider: identity.provider, model: identity.model } : {}),
		};
	}
}

/** Uses the first supporting model-aware counter and fails open to the explicit structural fallback. */
export function countTextWithFallback(
	input: TextTokenCountInput,
	counters: readonly TextTokenCounter[],
	fallback: TextTokenCounter = new StructuralTextTokenCounter(),
): TokenMeasurement {
	for (const counter of counters) {
		try {
			const measurement = counter.countText(input);
			if (measurement) return validateTokenMeasurement(measurement);
		} catch {
			// Counting is observational. Unknown mappings/tokenizer failures must remain visibly estimated, never block the request.
		}
	}
	const measurement = fallback.countText(input);
	if (!measurement) throw new Error("structural token counter did not return a measurement");
	return validateTokenMeasurement(measurement);
}

export interface RequestTokenReconciliation {
	aggregate: TokenMeasurement;
	attributedTokens: number;
	residual: TokenMeasurement;
	overshootTokens: number;
}

const REQUEST_RECONCILIATION_FIELDS = new Set<keyof RequestTokenReconciliation>([
	"aggregate",
	"attributedTokens",
	"residual",
	"overshootTokens",
]);

export function validateRequestTokenReconciliation(value: unknown): RequestTokenReconciliation {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("request token reconciliation must be an object");
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!REQUEST_RECONCILIATION_FIELDS.has(key as keyof RequestTokenReconciliation))
			throw new Error(`request token reconciliation contains unsupported field: ${key}`);
	}
	const aggregate = validateTokenMeasurement(input.aggregate);
	const residual = validateTokenMeasurement(input.residual);
	if (aggregate.scope !== "request-context" && aggregate.scope !== "request-input")
		throw new Error("request token aggregate scope is invalid");
	if (
		residual.scope !== "unattributed-residual" ||
		residual.provenance !== "structural-estimate" ||
		residual.method !== "aggregate-minus-attributed"
	)
		throw new Error("request token residual provenance is invalid");
	if (residual.provider !== aggregate.provider || residual.model !== aggregate.model)
		throw new Error("request token residual identity does not match aggregate identity");
	const attributedTokens = input.attributedTokens;
	const overshootTokens = input.overshootTokens;
	if (typeof attributedTokens !== "number" || !Number.isSafeInteger(attributedTokens) || attributedTokens < 0)
		throw new Error("request token attributed count is invalid");
	if (typeof overshootTokens !== "number" || !Number.isSafeInteger(overshootTokens) || overshootTokens < 0)
		throw new Error("request token overshoot count is invalid");
	if (residual.tokens !== Math.max(0, aggregate.tokens - attributedTokens)) throw new Error("request token residual is inconsistent");
	if (overshootTokens !== Math.max(0, attributedTokens - aggregate.tokens)) throw new Error("request token overshoot is inconsistent");
	return { aggregate, attributedTokens, residual, overshootTokens };
}

/**
 * Reconciles local item measurements against an authoritative request aggregate without spreading
 * its remainder across those items. The residual stays explicit and estimate-provenance because
 * provider envelope/media/rewrites and mixed local counting methods prevent exact attribution.
 */
export function reconcileRequestTokens(
	aggregateValue: TokenMeasurement,
	attributedValues: readonly TokenMeasurement[],
): RequestTokenReconciliation {
	const aggregate = validateTokenMeasurement(aggregateValue);
	if (aggregate.scope !== "request-context" && aggregate.scope !== "request-input")
		throw new Error("request token aggregate scope is invalid");
	const attributed = attributedValues.map(validateTokenMeasurement);
	if (attributed.some((measurement) => measurement.scope !== "context-item")) throw new Error("request token attribution scope is invalid");
	const attributedTokens = attributed.reduce((sum, measurement) => {
		const next = sum + measurement.tokens;
		if (!Number.isSafeInteger(next)) throw new Error("request token attribution sum is invalid");
		return next;
	}, 0);
	const difference = aggregate.tokens - attributedTokens;
	return {
		aggregate,
		attributedTokens,
		residual: {
			tokens: Math.max(0, difference),
			scope: "unattributed-residual",
			provenance: "structural-estimate",
			method: "aggregate-minus-attributed",
			...(aggregate.provider && aggregate.model ? { provider: aggregate.provider, model: aggregate.model } : {}),
		},
		overshootTokens: Math.max(0, -difference),
	};
}
