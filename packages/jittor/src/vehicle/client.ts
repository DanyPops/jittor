import { AuthenticatedRpcClient, type FetchTransport } from "@danypops/vehicle-client/rpc-client";
import { ensureAuthToken, type JittorPaths, readDaemonHandle, resolveJittorPaths } from "../state.ts";
import { invokeResetContract, isResetOperation } from "./reset-contracts.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export type { FetchTransport };

/** Provides authenticated RPC with contract-validated reset requests and responses. */
export class JittorClient extends AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs> {
	private readonly signaledClient: (signal: AbortSignal) => AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

	constructor(baseUrl: string, token: string, transport: FetchTransport = fetch) {
		super(baseUrl, token, { label: "Jittor", transport });
		this.signaledClient = (signal) =>
			new AuthenticatedRpcClient(baseUrl, token, {
				label: "Jittor",
				transport: (request) => transport(new Request(request, { signal })),
			});
	}
	override async call<N extends OperationName>(
		operation: N,
		input: OperationInputs[N],
		signal?: AbortSignal,
	): Promise<OperationOutputs[N]> {
		signal?.throwIfAborted();
		const invoke = (parsed: OperationInputs[N]) =>
			signal ? this.signaledClient(signal).call(operation, parsed) : super.call(operation, parsed);
		if (isResetOperation(operation))
			return invokeResetContract(operation, input, (parsed) => invoke(parsed as OperationInputs[N])) as Promise<OperationOutputs[N]>;
		return invoke(input);
	}
}

export function connectJittorClient(paths: JittorPaths = resolveJittorPaths()): JittorClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Jittor daemon is not running; install or start jittor.service");
	const token = ensureAuthToken(paths);
	return new JittorClient(`http://${handle.host}:${handle.port}`, token);
}
