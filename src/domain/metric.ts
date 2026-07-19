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

export function validateMetricObservation(value: unknown): MetricObservation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("metric observation must be an object");
	const input = value as Record<string, unknown>;
	for (const key of ["source", "scope", "metric", "unit"] as const) {
		if (typeof input[key] !== "string" || input[key].trim().length === 0) throw new Error(`${key} is required`);
	}
	if (!METRIC_UNITS.includes(input["unit"] as MetricUnit)) throw new Error("unit is not supported");
	if (input["value"] !== null && (typeof input["value"] !== "number" || !Number.isFinite(input["value"]))) {
		throw new Error("value must be finite or null");
	}
	if (typeof input["observedAt"] !== "number" || !Number.isSafeInteger(input["observedAt"]) || input["observedAt"] < 0) {
		throw new Error("observedAt must be a non-negative integer timestamp");
	}
	if (input["attributes"] !== undefined && (typeof input["attributes"] !== "object" || input["attributes"] === null || Array.isArray(input["attributes"]))) {
		throw new Error("attributes must be an object");
	}
	return {
		source: input["source"] as string,
		scope: input["scope"] as string,
		metric: input["metric"] as string,
		value: input["value"] as number | null,
		unit: input["unit"] as MetricUnit,
		observedAt: input["observedAt"] as number,
		attributes: (input["attributes"] as Record<string, unknown> | undefined) ?? {},
	};
}
