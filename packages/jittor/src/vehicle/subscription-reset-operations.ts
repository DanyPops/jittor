import type { ResetRedemption, SubscriptionResets } from "../observability/subscription-resets.ts";
import type { OperationHandlerMap } from "./operation-types.ts";

export function subscriptionResetOperations(resets?: SubscriptionResets): OperationHandlerMap {
	const configured = () => {
		if (!resets) throw new Error("Codex subscription resets are not configured");
		return resets;
	};
	return {
		"subscription.resets.list": () => configured().list(),
		"subscription.resets.redeem": (input) => configured().redeem(input as unknown as ResetRedemption & { confirm: boolean }),
	};
}
