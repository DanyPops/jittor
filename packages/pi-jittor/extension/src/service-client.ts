import { connectJittorClient, type JittorClient, type OperationInputs, type OperationName, type OperationOutputs } from "@danypops/jittor";
import { createRetryingClient, type RetryingClient } from "@danypops/vehicle-client/daemon-client";

type JittorConnector = () => Promise<JittorClient>;

function defaultConnector(): Promise<JittorClient> {
	return Promise.resolve(connectJittorClient());
}

let connector: JittorConnector = defaultConnector;
let retrying: RetryingClient<JittorClient> = createRetryingClient(() => connector(), { label: "Jittor" });

/**
 * Exhaustive transport-retry policy. New daemon operations cannot compile until their mutability
 * is classified: only reads may be transparently invoked twice after a connection-shaped error.
 */
const OPERATION_RETRY_MODE = {
	"metrics.record": "once",
	"metrics.record_batch": "once",
	"metrics.query": "retry",
	"metrics.distinct_scopes": "retry",
	"metrics.usage_series": "retry",
	"metrics.cost_by_task": "retry",
	"metrics.prune": "once",
	"benchmark.refresh": "once",
	"benchmark.status": "retry",
	"benchmark.query": "retry",
	"catalog.refresh": "once",
	"catalog.status": "retry",
	"catalog.query": "retry",
	"session.register": "once",
	"session.release": "once",
	"models.rank": "once",
	"context.assess": "retry",
	"context.delta": "retry",
	"context.snapshot": "once",
	"compaction.estimate": "retry",
	"service.checkpoint": "once",
	"telemetry.poll": "retry",
	"router.status": "retry",
	"router.decide": "retry",
	"router.pause": "once",
	"router.resume": "once",
	"router.override": "once",
	"router.clear_override": "once",
	"router.current_route": "once",
	"router.available_routes": "once",
} as const satisfies Record<OperationName, "retry" | "once">;

export function operationRetryMode(operation: OperationName): "retry" | "once" {
	return OPERATION_RETRY_MODE[operation];
}

export async function callJittor<Name extends OperationName>(
	operation: Name,
	input: OperationInputs[Name],
): Promise<OperationOutputs[Name]> {
	const invoke = (client: JittorClient) => client.call(operation, input);
	return operationRetryMode(operation) === "retry" ? retrying.call(invoke) : retrying.callOnce(invoke);
}

export function setJittorClientConnectorForTests(value: JittorConnector): void {
	connector = value;
	retrying = createRetryingClient(() => connector(), { label: "Jittor" });
}

export function resetJittorClientForTests(): void {
	connector = defaultConnector;
	retrying = createRetryingClient(() => connector(), { label: "Jittor" });
}
