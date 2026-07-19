import type { MetricObservation } from "../domain/metric.ts";

export interface CodexWindow {
	usedPercent: number;
	windowSeconds: number | null;
	resetAfterSeconds: number | null;
	resetsAt: number | null;
}

export interface CodexCredits {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
}

export interface CodexRateLimitSnapshot {
	limitId: string;
	limitName: string | null;
	allowed: boolean | null;
	limitReached: boolean | null;
	primary: CodexWindow | null;
	secondary: CodexWindow | null;
	credits: CodexCredits | null;
	observedAt: number;
	metrics: MetricObservation[];
}

export interface CodexSpendLimit {
	source: string | null;
	limit: string;
	used: string;
	remaining: string;
	usedPercent: number;
	remainingPercent: number;
	resetAfterSeconds: number;
	resetsAt: number;
}

export interface CodexSpendControl {
	reached: boolean;
	individualLimit: CodexSpendLimit | null;
}

export interface CodexUsageSnapshot {
	stability: "experimental";
	planType: string;
	defaultLimit: CodexRateLimitSnapshot;
	additionalLimits: CodexRateLimitSnapshot[];
	credits: CodexCredits | null;
	spendControl: CodexSpendControl | null;
	rateLimitReachedType: string | null;
	observedAt: number;
	metrics: MetricObservation[];
}

function schema(message: string): never {
	throw new Error(`Codex experimental usage schema changed: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) schema(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) schema(`${name} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, name: string): string | null {
	return value === undefined || value === null ? null : string(value, name);
}

function boolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") schema(`${name} must be boolean`);
	return value;
}

function finite(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) schema(`${name} must be finite`);
	return value;
}

function integer(value: unknown, name: string): number {
	const parsed = finite(value, name);
	if (!Number.isSafeInteger(parsed)) schema(`${name} must be an integer`);
	return parsed;
}

function percent(value: unknown, name: string): number {
	const parsed = finite(value, name);
	if (parsed < 0 || parsed > 100) throw new Error(`Codex ${name} used percent must be between 0 and 100`);
	return parsed;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | null {
	return value === undefined || value === null ? null : record(value, name);
}

function parseWindow(value: unknown, name: string): CodexWindow | null {
	const window = optionalRecord(value, name);
	if (!window) return null;
	return {
		usedPercent: percent(window["used_percent"], name),
		windowSeconds: integer(window["limit_window_seconds"], `${name} window seconds`),
		resetAfterSeconds: integer(window["reset_after_seconds"], `${name} reset after seconds`),
		resetsAt: integer(window["reset_at"], `${name} reset at`),
	};
}

function parseCredits(value: unknown): CodexCredits | null {
	const credits = optionalRecord(value, "credits");
	if (!credits) return null;
	return {
		hasCredits: boolean(credits["has_credits"], "credits has_credits"),
		unlimited: boolean(credits["unlimited"], "credits unlimited"),
		balance: optionalString(credits["balance"], "credits balance"),
	};
}

function parseRateLimit(
	value: unknown,
	limitId: string,
	limitName: string | null,
	credits: CodexCredits | null,
	observedAt: number,
): CodexRateLimitSnapshot {
	const rateLimit = optionalRecord(value, `${limitId} rate limit`);
	if (!rateLimit) {
		return { limitId, limitName, allowed: null, limitReached: null, primary: null, secondary: null, credits, observedAt, metrics: [] };
	}
	const snapshot: CodexRateLimitSnapshot = {
		limitId,
		limitName,
		allowed: boolean(rateLimit["allowed"], `${limitId} allowed`),
		limitReached: boolean(rateLimit["limit_reached"], `${limitId} limit_reached`),
		primary: parseWindow(rateLimit["primary_window"], `${limitId} primary`),
		secondary: parseWindow(rateLimit["secondary_window"], `${limitId} secondary`),
		credits,
		observedAt,
		metrics: [],
	};
	snapshot.metrics = rateLimitMetrics(snapshot);
	return snapshot;
}

function metric(
	scope: string,
	name: string,
	value: number,
	unit: MetricObservation["unit"],
	observedAt: number,
	attributes: Record<string, unknown> = {},
): MetricObservation {
	return { source: "codex-subscription", scope, metric: name, value, unit, observedAt, attributes: { experimental: true, ...attributes } };
}

function windowMetrics(snapshot: CodexRateLimitSnapshot, name: "primary" | "secondary", window: CodexWindow | null): MetricObservation[] {
	if (!window) return [];
	const scope = snapshot.limitId === "codex" ? `codex:${name}` : `${snapshot.limitId}:${name}`;
	return [metric(scope, "used-fraction", window.usedPercent / 100, "ratio", snapshot.observedAt, {
		limitId: snapshot.limitId,
		limitName: snapshot.limitName,
		windowSeconds: window.windowSeconds,
		resetAfterSeconds: window.resetAfterSeconds,
		resetsAt: window.resetsAt,
	})];
}

export function rateLimitMetrics(snapshot: CodexRateLimitSnapshot): MetricObservation[] {
	const metrics = [
		...windowMetrics(snapshot, "primary", snapshot.primary),
		...windowMetrics(snapshot, "secondary", snapshot.secondary),
	];
	if (snapshot.allowed !== null) metrics.push(metric(snapshot.limitId, "allowed", snapshot.allowed ? 1 : 0, "count", snapshot.observedAt));
	if (snapshot.limitReached !== null) metrics.push(metric(snapshot.limitId, "limit-reached", snapshot.limitReached ? 1 : 0, "count", snapshot.observedAt));
	return metrics;
}

function parseSpendControl(value: unknown): CodexSpendControl | null {
	const spend = optionalRecord(value, "spend control");
	if (!spend) return null;
	const limit = optionalRecord(spend["individual_limit"], "spend individual limit");
	return {
		reached: boolean(spend["reached"], "spend control reached"),
		individualLimit: limit ? {
			source: optionalString(limit["source"], "spend source"),
			limit: string(limit["limit"], "spend limit"),
			used: string(limit["used"], "spend used"),
			remaining: string(limit["remaining"], "spend remaining"),
			usedPercent: percent(limit["used_percent"], "spend"),
			remainingPercent: percent(limit["remaining_percent"], "spend remaining"),
			resetAfterSeconds: integer(limit["reset_after_seconds"], "spend reset after"),
			resetsAt: integer(limit["reset_at"], "spend reset at"),
		} : null,
	};
}

export function parseCodexUsage(value: unknown, observedAt = Date.now()): CodexUsageSnapshot {
	const payload = record(value, "payload");
	const planType = string(payload["plan_type"], "plan_type");
	const credits = parseCredits(payload["credits"]);
	const defaultLimit = parseRateLimit(payload["rate_limit"], "codex", null, credits, observedAt);
	const additionalValue = payload["additional_rate_limits"];
	if (additionalValue !== undefined && additionalValue !== null && !Array.isArray(additionalValue)) schema("additional_rate_limits must be an array");
	const additionalLimits = (additionalValue as unknown[] | null | undefined ?? []).map((entry) => {
		const additional = record(entry, "additional rate limit");
		const limitName = string(additional["limit_name"], "additional limit_name");
		const limitId = string(additional["metered_feature"], "additional metered_feature").trim().toLowerCase().replaceAll("-", "_");
		return parseRateLimit(additional["rate_limit"], limitId, limitName, credits, observedAt);
	});
	const reached = optionalRecord(payload["rate_limit_reached_type"], "rate limit reached type");
	const spendControl = parseSpendControl(payload["spend_control"]);
	const metrics = [...defaultLimit.metrics, ...additionalLimits.flatMap((limit) => limit.metrics)];
	if (credits?.balance !== null && credits?.balance !== undefined) {
		const balance = Number(credits.balance);
		if (Number.isFinite(balance)) metrics.push(metric("codex:credits", "balance", balance, "count", observedAt));
	}
	if (spendControl?.individualLimit) {
		metrics.push(metric("codex:spend-control", "used-fraction", spendControl.individualLimit.usedPercent / 100, "ratio", observedAt, {
			resetsAt: spendControl.individualLimit.resetsAt,
		}));
	}
	return {
		stability: "experimental",
		planType,
		defaultLimit,
		additionalLimits,
		credits,
		spendControl,
		rateLimitReachedType: reached ? string(reached["type"], "rate limit reached type") : null,
		observedAt,
		metrics,
	};
}

function headerNumber(headers: Headers, name: string, integerOnly = false): number | null {
	const raw = headers.get(name);
	if (raw === null) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || (integerOnly && !Number.isSafeInteger(value))) throw new Error(`Codex experimental header schema changed: ${name}`);
	return value;
}

function headerBoolean(headers: Headers, name: string): boolean | null {
	const raw = headers.get(name);
	if (raw === null) return null;
	if (raw === "1" || raw.toLowerCase() === "true") return true;
	if (raw === "0" || raw.toLowerCase() === "false") return false;
	throw new Error(`Codex experimental header schema changed: ${name}`);
}

function parseHeaderWindow(headers: Headers, prefix: string, windowName: "primary" | "secondary"): CodexWindow | null {
	const usedName = `${prefix}-${windowName}-used-percent`;
	const minutesName = `${prefix}-${windowName}-window-minutes`;
	const resetName = `${prefix}-${windowName}-reset-at`;
	const used = headerNumber(headers, usedName);
	const minutes = headerNumber(headers, minutesName, true);
	const resetsAt = headerNumber(headers, resetName, true);
	if (used === null) {
		if (minutes !== null || resetsAt !== null) throw new Error(`Codex experimental header schema changed: ${usedName} missing`);
		return null;
	}
	if (used < 0 || used > 100) throw new Error(`Codex ${windowName} used percent must be between 0 and 100`);
	if (used === 0 && minutes === null && resetsAt === null) return null;
	return { usedPercent: used, windowSeconds: minutes === null ? null : minutes * 60, resetAfterSeconds: null, resetsAt };
}

function parseHeaderCredits(headers: Headers): CodexCredits | null {
	const hasCredits = headerBoolean(headers, "x-codex-credits-has-credits");
	const unlimited = headerBoolean(headers, "x-codex-credits-unlimited");
	const balance = headers.get("x-codex-credits-balance");
	if (hasCredits === null && unlimited === null && balance === null) return null;
	if (hasCredits === null || unlimited === null) throw new Error("Codex experimental header schema changed: incomplete credits");
	return { hasCredits, unlimited, balance: balance?.trim() || null };
}

export function parseCodexRateLimitHeaders(headers: Headers, observedAt = Date.now()): CodexRateLimitSnapshot[] {
	const prefixes = new Set<string>(["x-codex"]);
	for (const name of headers.keys()) {
		if (name.startsWith("x-") && name.endsWith("-primary-used-percent")) prefixes.add(name.slice(0, -"-primary-used-percent".length));
	}
	const credits = parseHeaderCredits(headers);
	const snapshots: CodexRateLimitSnapshot[] = [];
	for (const prefix of [...prefixes].sort((left, right) => left === "x-codex" ? -1 : right === "x-codex" ? 1 : left.localeCompare(right))) {
		const normalized = prefix.slice(2).replaceAll("-", "_");
		const primary = parseHeaderWindow(headers, prefix, "primary");
		const secondary = parseHeaderWindow(headers, prefix, "secondary");
		const limitName = headers.get(`${prefix}-limit-name`)?.trim() || null;
		if (prefix !== "x-codex" && !primary && !secondary) continue;
		if (prefix === "x-codex" && !primary && !secondary && !credits) continue;
		const snapshot: CodexRateLimitSnapshot = {
			limitId: normalized,
			limitName,
			allowed: null,
			limitReached: null,
			primary,
			secondary,
			credits,
			observedAt,
			metrics: [],
		};
		snapshot.metrics = rateLimitMetrics(snapshot);
		snapshots.push(snapshot);
	}
	return snapshots;
}
