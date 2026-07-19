import { readFileSync, statSync } from "node:fs";
import {
	parseCodexRateLimitHeaders,
	parseCodexUsage,
	type CodexRateLimitSnapshot,
	type CodexUsageSnapshot,
} from "./codex-contracts.ts";

export {
	parseCodexRateLimitHeaders,
	parseCodexUsage,
	rateLimitMetrics,
	type CodexCredits,
	type CodexRateLimitSnapshot,
	type CodexSpendControl,
	type CodexSpendLimit,
	type CodexUsageSnapshot,
	type CodexWindow,
} from "./codex-contracts.ts";

const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";

export interface CodexCredentials {
	accessToken: string;
	accountId: string;
}

export type CodexTransport = (request: Request) => Promise<Response>;

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Codex credentials schema changed: ${name}`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Codex credentials schema changed: ${name}`);
	return value;
}

/** Explicit file-mode credential bridge. Codex remains responsible for refresh. */
export function loadCodexFileCredentials(path: string): CodexCredentials {
	try {
		if ((statSync(path).mode & 0o077) !== 0) throw new Error("unsafe permissions");
	} catch (error) {
		if (error instanceof Error && error.message === "unsafe permissions") {
			throw new Error("Codex auth.json must use private file permissions");
		}
		throw new Error(`Codex credentials are unavailable at ${path}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Codex credentials are unavailable at ${path}`);
	}
	const root = record(parsed, "auth.json root");
	const tokens = record(root["tokens"], "auth.json tokens");
	return {
		accessToken: requiredString(tokens["access_token"], "access_token"),
		accountId: requiredString(tokens["account_id"], "account_id"),
	};
}

/**
 * Experimental adapter for the private ChatGPT Codex usage contract used by the
 * open-source Codex CLI. This is not a documented stable personal-plan API.
 */
export class CodexSubscriptionTelemetryAdapter {
	readonly stability = "experimental" as const;

	constructor(
		private readonly credentials: CodexCredentials,
		private readonly transport: CodexTransport = fetch,
		private readonly baseUrl = CHATGPT_BACKEND_BASE_URL,
	) {
		if (credentials.accessToken.length === 0 || credentials.accountId.length === 0) {
			throw new Error("Codex access token and account id are required");
		}
	}

	async readUsage(observedAt = Date.now()): Promise<CodexUsageSnapshot> {
		const response = await this.transport(new Request(`${this.baseUrl}/wham/usage`, {
			headers: {
				authorization: `Bearer ${this.credentials.accessToken}`,
				"chatgpt-account-id": this.credentials.accountId,
				accept: "application/json",
			},
		}));
		if (!response.ok) throw new Error(`Codex experimental usage request failed with HTTP ${response.status}`);
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error("Codex experimental usage response was not JSON");
		}
		return parseCodexUsage(payload, observedAt);
	}

	readResponseHeaders(headers: Headers, observedAt = Date.now()): CodexRateLimitSnapshot[] {
		return parseCodexRateLimitHeaders(headers, observedAt);
	}
}
