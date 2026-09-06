import type { ResetOutcome, ResetRedemption, SubscriptionResetList } from "./subscription-reset-schema.ts";

export type { ResetOutcome, ResetRedemption, SubscriptionReset, SubscriptionResetList } from "./subscription-reset-schema.ts";

/** Reads account-bound reset grants and redeems an explicitly selected grant. */
export interface SubscriptionResetProvider {
	readResets(): Promise<SubscriptionResetList>;
	redeemReset(input: ResetRedemption): Promise<ResetOutcome>;
}

/** Rejects malformed identities before making any provider request. */
export function validateResetRedemption(input: ResetRedemption): void {
	if (typeof input.creditId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input.creditId)) throw new Error("invalid reset creditId");
	if (typeof input.idempotencyKey !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.idempotencyKey))
		throw new Error("reset idempotencyKey must be a UUID; reuse it for retries");
}

/** Serializes account reset access and keeps post-redemption refresh failures distinct from redemption outcomes. */
export class SubscriptionResets {
	private busy = false;
	private refreshInFlight: Promise<boolean> | undefined;
	constructor(
		private readonly provider: SubscriptionResetProvider,
		private readonly refresh: () => Promise<unknown>,
		private readonly refreshWaitMs = 2000,
	) {
		if (!Number.isSafeInteger(refreshWaitMs) || refreshWaitMs < 1 || refreshWaitMs > 5000)
			throw new Error("reset refresh wait must be between 1 and 5000ms");
	}

	private async refreshTelemetry(): Promise<boolean> {
		if (this.refreshInFlight) return false;
		this.refreshInFlight = Promise.resolve()
			.then(() => this.refresh())
			.then(
				() => true,
				() => false,
			)
			.finally(() => {
				this.refreshInFlight = undefined;
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.refreshInFlight,
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), this.refreshWaitMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async exclusive<T>(run: () => Promise<T>): Promise<T> {
		if (this.busy) throw new Error("subscription reset request already in progress");
		this.busy = true;
		try {
			return await run();
		} finally {
			this.busy = false;
		}
	}

	list(): Promise<SubscriptionResetList> {
		return this.exclusive(() => this.provider.readResets());
	}

	async redeem(input: ResetRedemption & { confirm: boolean }): Promise<ResetOutcome & { telemetryRefreshed: boolean }> {
		if (input.confirm !== true) throw new Error("reset redemption requires confirm: true; this consumes one banked reset");
		validateResetRedemption(input);
		return this.exclusive(async () => {
			const outcome = await this.provider.redeemReset(input);
			let telemetryRefreshed = false;
			if (outcome.code === "reset" || outcome.code === "already_redeemed") {
				telemetryRefreshed = await this.refreshTelemetry();
			}
			return { ...outcome, telemetryRefreshed };
		});
	}
}
