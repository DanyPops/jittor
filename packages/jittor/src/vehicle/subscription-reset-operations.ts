import type { SubscriptionResets } from "../observability/subscription-resets.ts";
import type { OperationHandlerMap } from "./operation-types.ts";
import { invokeResetContract } from "./reset-contracts.ts";

export function subscriptionResetOperations(resets?: SubscriptionResets): OperationHandlerMap {
	const configured = () => {
		if (!resets) throw new Error("Codex subscription resets are not configured");
		return resets;
	};
	return {
		"subscription.resets.list": (input) => invokeResetContract("subscription.resets.list", input, () => configured().list()),
		"subscription.resets.redeem": (input) =>
			invokeResetContract("subscription.resets.redeem", input, (parsed) => configured().redeem(parsed)),
	};
}
