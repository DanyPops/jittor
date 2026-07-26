import type { RouteOverride, RouterController } from "../ports/router-controller.ts";
import type { Route } from "../policy.ts";
import type { OperationHandlerMap } from "./types.ts";
import { routerSessionId } from "./session-scope.ts";

/** telemetry.poll and every router.* operation -- reads pass a bare session_id through; mutations run authorize first, matching the opt-in session-identity armor. */
export function routerOperations(router: RouterController, authorize: (input: Record<string, unknown>) => string | undefined): OperationHandlerMap {
	return {
		"telemetry.poll": () => router.poll(),
		"router.status": (input) => router.status(routerSessionId(input)),
		"router.decide": (input) => router.decide(routerSessionId(input)),
		"router.pause": (input) => router.pause(authorize(input)),
		"router.resume": (input) => router.resume(authorize(input)),
		"router.override": (input) => router.setOverride(input as unknown as RouteOverride, authorize(input)),
		"router.clear_override": (input) => router.clearOverride(authorize(input)),
		"router.current_route": (input) => router.setCurrentRoute(input as unknown as Route, authorize(input)),
		"router.available_routes": (input) => router.setAvailableRoutes(Array.isArray(input["routes"]) ? input["routes"] as Route[] : [], authorize(input)),
	};
}
