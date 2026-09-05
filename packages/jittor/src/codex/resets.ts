import type { ResetOutcome, SubscriptionResetList } from "../observability/subscription-resets.ts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex reset schema changed");
	return value as Record<string, unknown>;
}

export function resetCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000)
		throw new Error("Codex reset count must be an integer between 0 and 10000");
	return value;
}

export function parseResetSummary(value: unknown): number | null {
	return value == null ? null : resetCount(record(value).available_count);
}

function field(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Codex reset identity schema changed");
	return value;
}

export function parseResetList(value: unknown): SubscriptionResetList {
	const payload = record(value);
	if (!Array.isArray(payload.credits) || payload.credits.length > 100)
		throw new Error("Codex reset credits exceed the list bound or changed schema");
	return {
		availableCount: resetCount(payload.available_count),
		credits: payload.credits.map((entry) => {
			const credit = record(entry);
			let expiresAt: string | null = null;
			if (credit.expires_at != null) {
				if (typeof credit.expires_at !== "string" || credit.expires_at.length > 40 || !Number.isFinite(Date.parse(credit.expires_at)))
					throw new Error("Codex reset expiration schema changed");
				expiresAt = new Date(credit.expires_at).toISOString();
			}
			return { id: field(credit.id), status: field(credit.status), resetType: field(credit.reset_type), expiresAt };
		}),
	};
}

export function parseResetOutcome(value: unknown): ResetOutcome {
	const { code } = record(value);
	if (code !== "reset" && code !== "already_redeemed" && code !== "nothing_to_reset" && code !== "no_credit")
		throw new Error("Codex reset outcome unknown; retry only with the same idempotency key");
	return { code };
}

/** Caps decoded response bytes even when the server omits Content-Length. */
export async function readResetJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Codex reset response was not JSON");
	const buffer = new Uint8Array(65_536);
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read().catch(() => {
				throw new Error("Codex reset response interrupted; for redemption retry only with the same idempotency key");
			});
			if (done) break;
			if (length + value.byteLength > buffer.byteLength) throw new Error("Codex reset response exceeds size limit");
			buffer.set(value, length);
			length += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder().decode(buffer.subarray(0, length)));
	} catch {
		throw new Error("Codex reset response was not JSON");
	}
}
