import type { ResetRedemption, SubscriptionResetProvider } from "../observability/subscription-resets.ts";
import { CodexSubscriptionTelemetryAdapter, loadCodexFileCredentials } from "./telemetry.ts";

/** Resolves the configured account credentials afresh for each reset operation. */
export class CodexResetSource implements SubscriptionResetProvider {
	constructor(private readonly authFile: string) {}
	private adapter(): CodexSubscriptionTelemetryAdapter {
		try {
			return new CodexSubscriptionTelemetryAdapter(loadCodexFileCredentials(this.authFile));
		} catch {
			throw new Error("Codex credentials unavailable; check the configured private auth file");
		}
	}
	readResets() {
		return this.adapter().readResets();
	}
	redeemReset(input: ResetRedemption) {
		return this.adapter().redeemReset(input);
	}
}
