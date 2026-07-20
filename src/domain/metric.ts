import { METRIC_ATTRIBUTES_MAX_DEPTH, METRIC_ATTRIBUTES_MAX_SERIALIZED_CHARACTERS, METRIC_IDENTITY_MAX_CHARACTERS } from "../constants.ts";

export const METRIC_UNITS = ["ratio", "usd", "tokens", "requests", "milliseconds", "count"] as const;
export type MetricUnit = typeof METRIC_UNITS[number];

export interface MetricObservation {
	source: string;
	scope: string;
	metric: string;
	value: number | null;
	unit: MetricUnit;
	observedAt: number;
	attributes?: Record<string, unknown>;
}

export interface StoredMetricObservation extends MetricObservation {
	id: number;
	attributes: Record<string, unknown>;
}

export interface MetricQuery {
	source?: string;
	scope?: string;
	metric?: string;
	since?: number;
	until?: number;
	limit?: number;
	order?: "asc" | "desc";
}

const SENSITIVE_ATTRIBUTE_KEYS = new Set([
	"accesstoken",
	"refreshtoken",
	"authorization",
	"apikey",
	"secret",
	"password",
	"cookie",
	"credential",
	"otpseed",
]);

function assertCredentialSafeAttributes(value: unknown, depth = 0): void {
	if (depth > METRIC_ATTRIBUTES_MAX_DEPTH) throw new Error("attributes exceed the nesting depth limit");
	if (Array.isArray(value)) {
		for (const item of value) assertCredentialSafeAttributes(item, depth + 1);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, nested] of Object.entries(value)) {
		const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (SENSITIVE_ATTRIBUTE_KEYS.has(normalized)) throw new Error("attributes contain a sensitive field");
		assertCredentialSafeAttributes(nested, depth + 1);
	}
}

function validateAttributes(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("attributes must be an object");
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error("attributes must be JSON serializable");
	}
	if (serialized.length > METRIC_ATTRIBUTES_MAX_SERIALIZED_CHARACTERS) throw new Error("attributes exceed the serialized size limit");
	assertCredentialSafeAttributes(value);
	return value as Record<string, unknown>;
}

export function validateMetricObservation(value: unknown): MetricObservation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("metric observation must be an object");
	const input = value as Record<string, unknown>;
	for (const key of ["source", "scope", "metric", "unit"] as const) {
		if (typeof input[key] !== "string" || input[key].trim().length === 0) throw new Error(`${key} is required`);
		if (input[key].length > METRIC_IDENTITY_MAX_CHARACTERS) throw new Error(`${key} exceeds the length limit`);
	}
	if (!METRIC_UNITS.includes(input["unit"] as MetricUnit)) throw new Error("unit is not supported");
	if (input["value"] !== null && (typeof input["value"] !== "number" || !Number.isFinite(input["value"]))) {
		throw new Error("value must be finite or null");
	}
	if (typeof input["observedAt"] !== "number" || !Number.isSafeInteger(input["observedAt"]) || input["observedAt"] < 0) {
		throw new Error("observedAt must be a non-negative integer timestamp");
	}
	const attributes = validateAttributes(input["attributes"]);
	return {
		source: input["source"] as string,
		scope: input["scope"] as string,
		metric: input["metric"] as string,
		value: input["value"] as number | null,
		unit: input["unit"] as MetricUnit,
		observedAt: input["observedAt"] as number,
		attributes,
	};
}
