import { type Static, Type } from "typebox";

const identity = Type.String({ minLength: 1, maxLength: 200 });
export const subscriptionResetSchema = Type.Object(
	{
		id: identity,
		status: identity,
		resetType: identity,
		expiresAt: Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()]),
	},
	{ additionalProperties: false },
);
export const subscriptionResetListSchema = Type.Object(
	{
		availableCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
		credits: Type.Array(subscriptionResetSchema, { maxItems: 100 }),
	},
	{ additionalProperties: false },
);
export const resetRedemptionSchema = Type.Object(
	{
		creditId: identity,
		idempotencyKey: Type.String({ minLength: 36, maxLength: 36 }),
	},
	{ additionalProperties: false },
);
export const confirmedResetSchema = Type.Object(
	{
		...resetRedemptionSchema.properties,
		confirm: Type.Literal(true),
	},
	{ additionalProperties: false },
);
export const resetOutcomeSchema = Type.Object(
	{
		code: Type.Union([
			Type.Literal("reset"),
			Type.Literal("already_redeemed"),
			Type.Literal("nothing_to_reset"),
			Type.Literal("no_credit"),
		]),
	},
	{ additionalProperties: false },
);
export const refreshedResetOutcomeSchema = Type.Object(
	{
		...resetOutcomeSchema.properties,
		telemetryRefreshed: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export type SubscriptionReset = Static<typeof subscriptionResetSchema>;
export type SubscriptionResetList = Static<typeof subscriptionResetListSchema>;
export type ResetRedemption = Static<typeof resetRedemptionSchema>;
export type ResetOutcome = Static<typeof resetOutcomeSchema>;
