import { type ResetOutcome, type SubscriptionResetList, validateResetRedemption } from "../observability/subscription-resets.ts";
import type { CliDependencies } from "./support.ts";

export const RESETS_USAGE_LINES = [
	"  resets list [--json]",
	"  resets redeem --credit-id <id> --idempotency-key <uuid> --confirm [--json]",
	"    Consumes one banked Codex reset. Retry an uncertain outcome with the SAME credit id and key.",
];

export function formatResets(result: SubscriptionResetList): string {
	return [
		`Codex: ${result.availableCount} reset${result.availableCount === 1 ? "" : "s"} available`,
		...result.credits.map((credit) => `${credit.id} · ${credit.status} · ${credit.resetType} · expires ${credit.expiresAt ?? "unknown"}`),
	].join("\n");
}

export async function runResetsCommand(
	action: string | undefined,
	args: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	if (action !== "list" && action !== "redeem") return usage();
	let json = false,
		confirm = false,
		creditId = "",
		idempotencyKey = "";
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (seen.has(arg)) return usage();
		seen.add(arg);
		if (arg === "--json") json = true;
		else if (action === "redeem" && arg === "--confirm") confirm = true;
		else if (action === "redeem" && arg === "--credit-id") creditId = args[++i] ?? "";
		else if (action === "redeem" && arg === "--idempotency-key") idempotencyKey = args[++i] ?? "";
		else return usage();
	}
	if (action === "redeem") {
		if (!confirm) return usage();
		try {
			validateResetRedemption({ creditId, idempotencyKey });
		} catch {
			return usage();
		}
	}
	try {
		if (action === "list") {
			const result = await deps.client.call("subscription.resets.list", {});
			deps.stdout(json ? JSON.stringify(result) : formatResets(result));
		} else {
			const result = await deps.client.call("subscription.resets.redeem", { confirm, creditId, idempotencyKey });
			const messages: Record<ResetOutcome["code"], string> = {
				reset: "Codex reset redeemed.",
				already_redeemed: "This reset request already completed.",
				nothing_to_reset: "No eligible usage window to reset.",
				no_credit: "No banked reset available.",
			};
			deps.stdout(
				json
					? JSON.stringify(result)
					: `${messages[result.code]}${result.telemetryRefreshed ? " Usage refreshed." : " Run telemetry poll to check current usage."}`,
			);
		}
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : "Subscription reset request failed");
		return 1;
	}
}
