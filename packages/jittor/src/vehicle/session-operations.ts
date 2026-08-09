import type { SessionIdentity } from "../sessions/identity.ts";
import { requiredString, routerSessionSecret } from "../sessions/router-authorization.ts";
import type { OperationHandlerMap } from "../vehicle/operation-types.ts";

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
