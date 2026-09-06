import type { JsonSchema } from "@danypops/vehicle-core";
import { type ResetOutcome, type SubscriptionResetList, validateResetRedemption } from "../observability/subscription-resets.ts";
import { invokeResetContract, type ResetOperationName, resetProjections } from "../vehicle/reset-contracts.ts";
import type { CliDependencies } from "./support.ts";

function fields(name: ResetOperationName): Array<[string, JsonSchema]> {
	return Object.entries(resetProjections[name].descriptor.inputSchema.properties as Record<string, JsonSchema>);
}
function flag(field: string): string {
	return `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}
function usageLine(name: ResetOperationName): string {
	const flags = fields(name).map(([field, schema]) => `${flag(field)}${schema.const === true ? "" : ` <${field}>`}`);
	return `  resets ${name.split(".").at(-1)} ${[...flags, "[--json]"].join(" ")}`;
}
export const RESETS_USAGE_LINES = [
	...Object.keys(resetProjections).map((name) => usageLine(name as ResetOperationName)),
	"  resets <list|redeem> --input '<JSON>' [--json]",
	"  resets <list|redeem> --help [--json]",
	"    Retry an uncertain redemption only with the SAME credit id and key.",
];

export function formatResets(result: SubscriptionResetList): string {
	return [
		`Codex: ${result.availableCount} reset${result.availableCount === 1 ? "" : "s"} available`,
		...result.credits.map((credit) => `${credit.id} · ${credit.status} · ${credit.resetType} · expires ${credit.expiresAt ?? "unknown"}`),
	].join("\n");
}
function canonicalArgs(name: ResetOperationName, args: string[]): string[] {
	if (args.includes("--input")) return args;
	const properties = new Map(fields(name).map(([key, schema]) => [flag(key), { key, schema }]));
	const seen = new Set<string>();
	const input: Record<string, unknown> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (seen.has(arg)) throw new Error("Duplicate reset flag");
		seen.add(arg);
		if (arg === "--json") continue;
		const property = properties.get(arg);
		if (!property) throw new Error("Unknown reset flag");
		input[property.key] = property.schema.const === true ? true : args[++i];
	}
	return ["--input", JSON.stringify(input)];
}
export async function runResetsCommand(
	action: string | undefined,
	args: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	if (action !== "list" && action !== "redeem") return usage();
	if (args.length > 8 || args.some((arg) => arg.length > 8192) || new TextEncoder().encode(args.join(" ")).byteLength > 8192)
		return usage();
	const name = `subscription.resets.${action}` as const;
	const json = args.includes("--json");
	if (args.includes("--help")) {
		if (args.length > 2 || new Set(args).size !== args.length || args.some((arg) => arg !== "--help" && arg !== "--json")) return usage();
		const help = {
			...JSON.parse(resetProjections[name].help),
			usage: `jittor resets ${action} --input '<JSON>' [--json]`,
			aliases: usageLine(name).trim(),
		};
		deps.stdout(json ? JSON.stringify(help) : `${help.aliases}\n${help.usage}\n${resetProjections[name].descriptor.description}`);
		return 0;
	}
	let input: object;
	try {
		input = resetProjections[name].parseArgs(canonicalArgs(name, args));
		if (action === "redeem")
			validateResetRedemption(resetProjections["subscription.resets.redeem"].parseArgs(["--input", JSON.stringify(input)]));
	} catch {
		return usage();
	}
	try {
		if (action === "list") {
			const result = await invokeResetContract("subscription.resets.list", input, (value) =>
				deps.client.call("subscription.resets.list", value),
			);
			deps.stdout(json ? JSON.stringify(result) : formatResets(result));
		} else {
			const result = await invokeResetContract("subscription.resets.redeem", input, (value) =>
				deps.client.call("subscription.resets.redeem", value),
			);
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
