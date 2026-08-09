import type { SessionIdentity } from "./identity.ts";

/** Shared input parsing for every operation that accepts an optional session_id/session_secret pair. */
export function routerSessionId(input: Record<string, unknown>): string | undefined {
	const value = input.session_id;
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("session_id must be a string");
	return value;
}

export function routerSessionSecret(input: Record<string, unknown>): string | undefined {
	const value = input.session_secret;
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("session_secret must be a string");
	return value;
}

export function requiredString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

/** Opt-in armor: a session_id never registered via session.register mutates exactly as before. Bound once per JittorService instance and shared by every router-mutating operation module. */
export function routerMutationAuthorizer(
	sessionIdentity: SessionIdentity | undefined,
): (input: Record<string, unknown>) => string | undefined {
	return (input) => {
		const sessionId = routerSessionId(input);
		sessionIdentity?.assertAuthorized(sessionId, routerSessionSecret(input));
		return sessionId;
	};
}
