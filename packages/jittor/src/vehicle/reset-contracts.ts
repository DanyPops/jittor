import { projectVehicleOperation, VehicleError, type VehicleOperation, type VehicleSchemaCodec } from "@danypops/vehicle-core";
import { defineStrictVehicleOperation } from "@danypops/vehicle-core/typebox";
import { Type } from "typebox";
import {
	confirmedResetSchema,
	refreshedResetOutcomeSchema,
	subscriptionResetListSchema,
} from "../observability/subscription-reset-schema.ts";

const limits = { defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxRequestBytes: 1024, maxResponseBytes: 65_536 };
export const resetContracts = Object.freeze({
	"subscription.resets.list": defineStrictVehicleOperation({
		name: "subscription.resets.list",
		version: 1,
		description: "Lists up to 100 Codex banked resets and the authoritative available count.",
		input: Type.Object({}, { additionalProperties: false }),
		output: subscriptionResetListSchema,
		permissions: ["jittor:read"],
		effect: "read",
		idempotency: { mode: "safe" },
		limits,
	}),
	"subscription.resets.redeem": defineStrictVehicleOperation({
		name: "subscription.resets.redeem",
		version: 1,
		description:
			"Consumes a selected Codex banked reset. Requires confirm:true, creditId and a UUID idempotencyKey; retry an uncertain outcome only with the same credit and key.",
		input: confirmedResetSchema,
		output: refreshedResetOutcomeSchema,
		permissions: ["jittor:read", "jittor:write"],
		effect: "external-write",
		idempotency: { mode: "unsafe" },
		limits,
	}),
});
export type ResetOperationName = keyof typeof resetContracts;
export const RESET_OPERATION_NAMES = Object.freeze(Object.keys(resetContracts) as ResetOperationName[]);
export type ResetInputs = { [N in ResetOperationName]: (typeof resetContracts)[N] extends VehicleOperation<infer I, unknown> ? I : never };
export type ResetOutputs = { [N in ResetOperationName]: (typeof resetContracts)[N] extends VehicleOperation<unknown, infer O> ? O : never };
export const resetProjections = Object.freeze({
	"subscription.resets.list": projectVehicleOperation(resetContracts["subscription.resets.list"]),
	"subscription.resets.redeem": projectVehicleOperation(resetContracts["subscription.resets.redeem"]),
});
export function isResetOperation(name: string): name is ResetOperationName {
	return Object.hasOwn(resetContracts, name);
}
/** Allows automatic retries only for explicitly safe reads. */
export function resetRetryMode(name: ResetOperationName): "retry" | "once" {
	const { effect, idempotency } = resetContracts[name].descriptor;
	return effect === "read" && idempotency.mode === "safe" ? "retry" : "once";
}
function parse<T>(codec: VehicleSchemaCodec<T>, input: unknown, output: boolean): T {
	const result = codec.safeParse(input);
	if (!result.success)
		throw new VehicleError(
			output ? "invalid-output" : "invalid-input",
			output
				? "Invalid reset output; for an uncertain redemption reuse the same credit and key."
				: "Invalid reset input; redemption requires confirm:true, a creditId and a UUID idempotencyKey.",
			{ category: output ? "internal" : "validation" },
		);
	return result.value;
}
/** Validates both sides of one invocation; transport retries remain the caller's explicit policy. */
export async function invokeResetContract<N extends ResetOperationName>(
	name: N,
	input: unknown,
	invoke: (input: ResetInputs[N]) => unknown | Promise<unknown>,
): Promise<ResetOutputs[N]> {
	const operation = resetContracts[name] as VehicleOperation<ResetInputs[N], ResetOutputs[N]>;
	return parse(operation.output, await invoke(parse(operation.input, input, false)), true);
}
