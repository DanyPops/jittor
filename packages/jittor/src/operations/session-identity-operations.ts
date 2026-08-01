import type { SessionIdentity } from "../session-identity-service.ts";
import { requiredString, routerSessionSecret } from "./session-scope.ts";
import type { OperationHandlerMap } from "./types.ts";

/** session.register and session.release -- the only two operations that mutate SessionIdentity itself, distinct from the router mutations it later authorizes. */
export function sessionIdentityOperations(sessionIdentity: SessionIdentity | undefined): OperationHandlerMap {
	const require = (): SessionIdentity => {
		if (!sessionIdentity) throw new Error("session identity is not configured");
		return sessionIdentity;
	};
	return {
		"session.register": (input) => require().register(requiredString(input, "session_id")),
		"session.release": (input) => require().release(requiredString(input, "session_id"), routerSessionSecret(input)),
	};
}
