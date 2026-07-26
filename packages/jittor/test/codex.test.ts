import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexSubscriptionTelemetryAdapter,
	loadCodexFileCredentials,
	parseCodexRateLimitHeaders,
	parseCodexUsage,
} from "../src/providers/codex.ts";

function response(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

const usagePayload = {
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 9_000, reset_at: 1_800_000_000 },
		secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 300_000, reset_at: 1_800_300_000 },
	},
	credits: { has_credits: true, unlimited: false, balance: "12.5", approx_local_messages: [], approx_cloud_messages: [] },
	spend_control: {
		reached: false,
		individual_limit: {
			source: "workspace", limit: "100", used: "20", remaining: "80",
			used_percent: 20, remaining_percent: 80, reset_after_seconds: 86_400, reset_at: 1_800_086_400,
		},
	},
	additional_rate_limits: [{
		limit_name: "GPT-5.2 Codex Sonic",
		metered_feature: "codex_bengalfox",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 10, limit_window_seconds: 3_600, reset_after_seconds: 1_800, reset_at: 1_800_001_800 },
			secondary_window: null,
		},
	}],
	rate_limit_reached_type: null,
};

describe("experimental Codex subscription telemetry", () => {
	it("calls the official CLI usage path without exposing credentials", async () => {
		const requests: Request[] = [];
		const adapter = new CodexSubscriptionTelemetryAdapter(
			{ accessToken: "oauth-secret", accountId: "account-1" },
			async (request) => { requests.push(request); return response(usagePayload); },
		);

		const snapshot = await adapter.readUsage(1_700_000_000_000);

		expect(adapter.stability).toBe("experimental");
		expect(requests[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer oauth-secret");
		expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("account-1");
		expect(snapshot.planType).toBe("plus");
		expect(snapshot.defaultLimit.primary?.usedPercent).toBe(25);
		expect(snapshot.additionalLimits[0]).toMatchObject({ limitId: "codex_bengalfox", limitName: "GPT-5.2 Codex Sonic" });
		expect(snapshot.credits).toEqual({ hasCredits: true, unlimited: false, balance: "12.5" });
		expect(snapshot.spendControl?.individualLimit?.remaining).toBe("80");
		expect(snapshot.metrics.map((metric) => [metric.scope, metric.metric, metric.value])).toContainEqual(["codex:primary", "used-fraction", 0.25]);
	});

	it("parses the live primary-only weekly schema without conflating a separate model limit", () => {
		const snapshot = parseCodexUsage({
			plan_type: "prolite",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 28, limit_window_seconds: 604_800, reset_after_seconds: 508_453, reset_at: 1_800_000_000 },
				secondary_window: null,
			},
			credits: { has_credits: false, unlimited: false, balance: "0" },
			additional_rate_limits: [{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 604_800, reset_at: 1_800_100_000 },
					secondary_window: null,
				},
			}],
			spend_control: null,
			rate_limit_reached_type: null,
		}, 1_700_000_000_000);

		expect(snapshot.defaultLimit).toMatchObject({ limitId: "codex", primary: { usedPercent: 28 }, secondary: null });
		expect(snapshot.additionalLimits[0]).toMatchObject({ limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 0 } });
		expect(snapshot.metrics.map((metric) => [metric.scope, metric.value])).toContainEqual(["codex:primary", 0.28]);
		expect(snapshot.metrics.map((metric) => [metric.scope, metric.value])).toContainEqual(["codex_bengalfox:primary", 0]);
	});

	it("parses official response-header updates for default and metered limits", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "30.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1800000000",
			"x-codex-secondary-used-percent": "60",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1800300000",
			"x-codex-credits-has-credits": "1",
			"x-codex-credits-unlimited": "false",
			"x-codex-credits-balance": "9.5",
			"x-codex-bengalfox-primary-used-percent": "12",
			"x-codex-bengalfox-primary-window-minutes": "60",
			"x-codex-bengalfox-primary-reset-at": "1800003600",
			"x-codex-bengalfox-limit-name": "GPT-5.2 Codex Sonic",
		});

		const updates = parseCodexRateLimitHeaders(headers, 1_700_000_000_000);

		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({ limitId: "codex", primary: { usedPercent: 30.5, windowSeconds: 18_000 }, credits: { balance: "9.5" } });
		expect(updates[1]).toMatchObject({ limitId: "codex_bengalfox", limitName: "GPT-5.2 Codex Sonic", primary: { usedPercent: 12, windowSeconds: 3_600 } });
	});

	it("loads only the required fields from explicitly configured file credentials", () => {
		const directory = mkdtempSync(join(tmpdir(), "codex-auth-"));
		const path = join(directory, "auth.json");
		writeFileSync(path, JSON.stringify({
			tokens: { access_token: "access-secret", refresh_token: "never-return", account_id: "account-2" },
		}), { mode: 0o600 });

		expect(loadCodexFileCredentials(path)).toEqual({ accessToken: "access-secret", accountId: "account-2" });
		const unsafePath = join(directory, "unsafe-auth.json");
		writeFileSync(unsafePath, JSON.stringify({ tokens: { access_token: "secret", account_id: "account-2" } }), { mode: 0o644 });
		expect(() => loadCodexFileCredentials(unsafePath)).toThrow("private file permissions");
	});

	it("fails closed on schema drift and impossible percentages", () => {
		expect(() => parseCodexUsage({ ...usagePayload, rate_limit: { ...usagePayload.rate_limit, allowed: "yes" } }, 1000)).toThrow("schema changed");
		expect(() => parseCodexUsage({
			...usagePayload,
			rate_limit: { ...usagePayload.rate_limit, primary_window: { ...usagePayload.rate_limit.primary_window, used_percent: 101 } },
		}, 1000)).toThrow("used percent");
		expect(() => parseCodexRateLimitHeaders(new Headers({ "x-codex-primary-used-percent": "not-a-number" }), 1000)).toThrow("header schema changed");
	});

	it("reports transport failures without logging or returning OAuth tokens", async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(
			{ accessToken: "oauth-super-secret", accountId: "account-1" },
			async () => response({ error: "denied" }, 401),
		);
		let message = "";
		try { await adapter.readUsage(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
		expect(message).toContain("HTTP 401");
		expect(message).not.toContain("oauth-super-secret");
	});
});
