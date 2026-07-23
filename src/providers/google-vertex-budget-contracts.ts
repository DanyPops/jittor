import type { BudgetWindow } from "../policy.ts";
import type { MetricObservation } from "../domain/metric.ts";
import type { GoogleVertexMetricSource } from "./google-vertex-contracts.ts";
import {
	GOOGLE_VERTEX_BUDGET_CONFIDENCE,
	GOOGLE_VERTEX_BUDGET_DISPLAY_NAME_MAX_CHARACTERS,
	MILLISECONDS_PER_SECOND,
} from "../constants.ts";

/**
 * Cloud Billing's programmatic budget notification schema (Pub/Sub attributes + base64 JSON data
 * body), verified against
 * https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications#notification-format
 * and the worked example in
 * https://docs.cloud.google.com/billing/docs/how-to/listen-to-notifications (fetched 2026-07-23).
 * This is the individual-GCP-project era's real hot(ish)-path budget signal Google documents:
 * "Budget notifications are sent to the Pub/Sub topic multiple times per day with the current
 * status of your budget", unlike the per-response rate-limit header Vertex generateContent itself
 * does not expose (see google-vertex-contracts.ts). Two honesty caveats the docs are explicit
 * about and this module must not paper over: (1) "Budgets use estimated Cloud Billing data which
 * is subject to change until your invoice is finalized" and (2) "Pub/Sub only provides
 * at-least-once delivery. You might receive a message multiple times, and messages might arrive
 * out of order."
 */
export type GoogleVertexBudgetAmountType = "SPECIFIED_AMOUNT" | "LAST_MONTH_COST" | "LAST_PERIODS_COST";

export interface GoogleVertexBudgetNotification {
	billingAccountId: string;
	budgetId: string;
	schemaVersion: string;
	budgetDisplayName: string;
	costAmount: number;
	costIntervalStart: number;
	budgetAmount: number;
	budgetAmountType: GoogleVertexBudgetAmountType;
	currencyCode: string;
	alertThresholdExceeded?: number;
	forecastThresholdExceeded?: number;
	publishedAt: number;
}

const BUDGET_AMOUNT_TYPES: readonly GoogleVertexBudgetAmountType[] = ["SPECIFIED_AMOUNT", "LAST_MONTH_COST", "LAST_PERIODS_COST"];

function requiredString(value: unknown, name: string, maxLength = 512): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new Error(`Google Vertex budget notification schema changed: ${name}`);
	}
	return value;
}

function requiredFiniteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Google Vertex budget notification schema changed: ${name}`);
	return value;
}

function requiredTimestamp(value: unknown, name: string): number {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(parsed)) throw new Error(`Google Vertex budget notification schema changed: ${name} is not RFC 3339`);
	return parsed;
}

function optionalFraction(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Google Vertex budget notification schema changed: ${name}`);
	return value;
}

/**
 * Parses one already-base64-decoded, JSON-parsed notification body plus its Pub/Sub message
 * attributes (`billingAccountId`, `budgetId`, `schemaVersion`) and the message's own
 * `publishTime`. Fails closed (throws) on any missing/mistyped field, matching the
 * `classifyGoogleVertexFailure`/Anthropic header-parsing convention: an unrecognized shape must
 * never be silently coerced into a plausible-looking budget number.
 */
export function parseGoogleVertexBudgetNotification(
	data: unknown,
	attributes: { billingAccountId?: unknown; budgetId?: unknown; schemaVersion?: unknown },
	publishedAt: number,
): GoogleVertexBudgetNotification {
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Google Vertex budget notification schema changed: data");
	const input = data as Record<string, unknown>;
	if (!Number.isFinite(publishedAt) || publishedAt < 0) throw new Error("Google Vertex budget notification schema changed: publishTime");

	const budgetAmountType = requiredString(input["budgetAmountType"], "budgetAmountType");
	if (!BUDGET_AMOUNT_TYPES.includes(budgetAmountType as GoogleVertexBudgetAmountType)) {
		throw new Error("Google Vertex budget notification schema changed: budgetAmountType");
	}

	return {
		billingAccountId: requiredString(attributes.billingAccountId, "billingAccountId"),
		budgetId: requiredString(attributes.budgetId, "budgetId"),
		schemaVersion: requiredString(attributes.schemaVersion, "schemaVersion"),
		budgetDisplayName: requiredString(input["budgetDisplayName"], "budgetDisplayName", GOOGLE_VERTEX_BUDGET_DISPLAY_NAME_MAX_CHARACTERS),
		costAmount: requiredFiniteNumber(input["costAmount"], "costAmount"),
		costIntervalStart: requiredTimestamp(input["costIntervalStart"], "costIntervalStart"),
		budgetAmount: requiredFiniteNumber(input["budgetAmount"], "budgetAmount"),
		budgetAmountType: budgetAmountType as GoogleVertexBudgetAmountType,
		currencyCode: requiredString(input["currencyCode"], "currencyCode", 8),
		alertThresholdExceeded: optionalFraction(input["alertThresholdExceeded"], "alertThresholdExceeded"),
		forecastThresholdExceeded: optionalFraction(input["forecastThresholdExceeded"], "forecastThresholdExceeded"),
		publishedAt,
	};
}

/**
 * Real dollar figures from Google, not a fabricated fraction: `spend`/`cap` are the two numbers
 * the notification actually carries, and `spend-fraction` is their honest quotient (which the
 * BudgetWindow below separately clamps to 1 for policy purposes -- this raw metric intentionally
 * is not clamped, so a genuine over-cap soft-quota period stays visible in the metrics history).
 */
export function googleVertexBudgetMetrics(
	notification: GoogleVertexBudgetNotification,
	observedAt: number,
	source: GoogleVertexMetricSource = "google-vertex",
): MetricObservation[] {
	const attributes: Record<string, unknown> = {
		billingAccountId: notification.billingAccountId,
		budgetId: notification.budgetId,
		budgetDisplayName: notification.budgetDisplayName,
		budgetAmountType: notification.budgetAmountType,
		currencyCode: notification.currencyCode,
		...(notification.alertThresholdExceeded !== undefined ? { alertThresholdExceeded: notification.alertThresholdExceeded } : {}),
		...(notification.forecastThresholdExceeded !== undefined ? { forecastThresholdExceeded: notification.forecastThresholdExceeded } : {}),
	};
	const metrics: MetricObservation[] = [
		{ source, scope: "budget", metric: "spend", value: notification.costAmount, unit: "usd", observedAt, attributes },
		{ source, scope: "budget", metric: "cap", value: notification.budgetAmount, unit: "usd", observedAt, attributes },
	];
	if (notification.budgetAmount > 0) {
		metrics.push({ source, scope: "budget", metric: "spend-fraction", value: notification.costAmount / notification.budgetAmount, unit: "ratio", observedAt, attributes });
	}
	return metrics;
}

/**
 * Cloud Billing's notification payload does not carry the budget's configured calendar period
 * (month/quarter/year/custom); the Budget resource itself defaults to a monthly period when
 * unset (see the Budget REST resource docs), and this is what Cloud Billing budgets default to
 * and what the P&GE individual-project migration documents ("The $500 quota limit is a monthly
 * limit"). Calendar periods reset "at 12 AM US and Canadian Pacific Time (UTC-8)" per Google's
 * own documented wording -- a fixed offset, not DST-aware America/Los_Angeles -- so this mirrors
 * that literal documented rule rather than a locale-aware guess.
 */
const PACIFIC_FIXED_OFFSET_MS = 8 * 60 * 60 * MILLISECONDS_PER_SECOND;

function nextPacificCalendarMonthStart(epochMs: number): number {
	const pacific = new Date(epochMs - PACIFIC_FIXED_OFFSET_MS);
	const nextMonthStartPacific = Date.UTC(pacific.getUTCFullYear(), pacific.getUTCMonth() + 1, 1, 0, 0, 0, 0);
	return nextMonthStartPacific + PACIFIC_FIXED_OFFSET_MS;
}

/**
 * Builds the BudgetWindow the routing policy consumes. Returns null (no window, not a fabricated
 * one) when `budgetAmount` isn't a usable positive cap. `usedFraction` is clamped to 1 for the
 * policy-facing window even when real spend has exceeded a soft-quota cap (the P&GE rollout keeps
 * serving requests past 100% during its soft-quota phase) -- clamping a known-to-be->=100% real
 * number to the window's documented [0,1] invariant is not fabrication; the unclamped truth is
 * still recorded by `googleVertexBudgetMetrics`'s `spend-fraction`.
 */
export function googleVertexBudgetWindow(
	notification: GoogleVertexBudgetNotification,
	observedAt: number,
	source: GoogleVertexMetricSource = "google-vertex",
): BudgetWindow | null {
	if (notification.budgetAmount <= 0) return null;
	const resetsAt = nextPacificCalendarMonthStart(notification.costIntervalStart);
	const windowSeconds = (resetsAt - notification.costIntervalStart) / MILLISECONDS_PER_SECOND;
	if (windowSeconds <= 0) return null;
	const usedFraction = Math.min(1, Math.max(0, notification.costAmount / notification.budgetAmount));
	return {
		id: `google-vertex-budget:${notification.budgetId}@${observedAt}`,
		source,
		scope: `budget:${notification.budgetId}`,
		usedFraction,
		windowSeconds,
		resetsAt,
		observedAt,
		freshness: "fresh",
		confidence: GOOGLE_VERTEX_BUDGET_CONFIDENCE,
	};
}
