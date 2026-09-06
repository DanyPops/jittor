import { AuthenticatedRpcClient, type FetchTransport } from "@danypops/vehicle-client/rpc-client";
import { ensureAuthToken, type JittorPaths, readDaemonHandle, resolveJittorPaths } from "../state.ts";
import { invokeResetContract, isResetOperation } from "./reset-contracts.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export type { FetchTransport };

/** Provides authenticated RPC with contract-validated reset requests and responses. */
export class JittorClient extends AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs> {
	constructor(baseUrl: string, token: string, transport: FetchTransport = fetch) {
		super(baseUrl, token, { label: "Jittor", transport });
	}
	override async call<N extends OperationName>(operation: N, input: OperationInputs[N]): Promise<OperationOutputs[N]> {
		if (isResetOperation(operation))
			return invokeResetContract(operation, input, (parsed) => super.call(operation, parsed as OperationInputs[N])) as Promise<
				OperationOutputs[N]
			>;
		return super.call(operation, input);
	}
}

export function connectJittorClient(paths: JittorPaths = resolveJittorPaths()): JittorClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Jittor daemon is not running; install or start jittor.service");
	const token = ensureAuthToken(paths);
	return new JittorClient(`http://${handle.host}:${handle.port}`, token);
}
