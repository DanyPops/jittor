import { AuthenticatedRpcClient, type FetchTransport } from "@danypops/daemon-kit/rpc-client";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";
import { ensureAuthToken, readDaemonHandle, resolveJittorPaths, type JittorPaths } from "./state.ts";

export type { FetchTransport };

/**
 * Jittor's typed authenticated RPC client, now a thin named subclass of
 * `@danypops/daemon-kit/rpc-client`'s `AuthenticatedRpcClient` -- the shared substrate factored
 * out after jittor's own client.ts and web-spider-daemon's were found byte-identical (see
 * daemon-kit's README). Keeps the old 3-positional-argument constructor so every existing call
 * site is untouched by this migration.
 */
export class JittorClient extends AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs> {
	constructor(baseUrl: string, token: string, transport: FetchTransport = fetch) {
		super(baseUrl, token, { label: "Jittor", transport });
	}
}

export function connectJittorClient(paths: JittorPaths = resolveJittorPaths()): JittorClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Jittor daemon is not running; install or start jittor.service");
	const token = ensureAuthToken(paths);
	return new JittorClient(`http://${handle.host}:${handle.port}`, token);
}
