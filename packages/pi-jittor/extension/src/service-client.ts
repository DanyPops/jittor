import { connectJittorClient, type JittorClient, type OperationInputs, type OperationName, type OperationOutputs } from "@danypops/jittor";
import { createRetryingClient, type RetryingClient } from "@danypops/vehicle-client/daemon-client";

type JittorConnector = () => Promise<JittorClient>;

function defaultConnector(): Promise<JittorClient> {
	return Promise.resolve(connectJittorClient());
}

let connector: JittorConnector = defaultConnector;
let retrying: RetryingClient<JittorClient> = createRetryingClient(() => connector(), { label: "Jittor" });

export async function callJittor<Name extends OperationName>(
	operation: Name,
	input: OperationInputs[Name],
): Promise<OperationOutputs[Name]> {
	return retrying.call((client) => client.call(operation, input));
}

export function setJittorClientConnectorForTests(value: JittorConnector): void {
	connector = value;
	retrying = createRetryingClient(() => connector(), { label: "Jittor" });
}

export function resetJittorClientForTests(): void {
	connector = defaultConnector;
	retrying = createRetryingClient(() => connector(), { label: "Jittor" });
}
