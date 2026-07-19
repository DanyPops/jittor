import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";
import { ensureAuthToken, readDaemonHandle, resolveJittorPaths, type JittorPaths } from "./state.ts";

export type FetchTransport = (request: Request) => Promise<Response>;

export class JittorClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly transport: FetchTransport = fetch,
	) {}

	async call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
		const response = await this.transport(new Request(`${this.baseUrl}/api/v1/ops`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify({ op: operation, input }),
		}));
		const body = await response.json() as { result?: OperationOutputs[Name]; error?: string };
		if (!response.ok) throw new Error(body.error ?? `Jittor operation failed with HTTP ${response.status}`);
		return body.result as OperationOutputs[Name];
	}

	async operations(): Promise<OperationName[]> {
		const response = await this.transport(new Request(`${this.baseUrl}/api/v1/ops`, {
			headers: { authorization: `Bearer ${this.token}` },
		}));
		const body = await response.json() as { operations?: OperationName[]; error?: string };
		if (!response.ok) throw new Error(body.error ?? `Jittor discovery failed with HTTP ${response.status}`);
		return body.operations ?? [];
	}

	async ready(): Promise<boolean> {
		const response = await this.transport(new Request(`${this.baseUrl}/ready`, {
			headers: { authorization: `Bearer ${this.token}` },
		}));
		if (response.status === 503) return false;
		if (!response.ok) throw new Error(`Jittor readiness check failed with HTTP ${response.status}`);
		return true;
	}

	async health(): Promise<{ ok: true; version: string }> {
		const response = await this.transport(new Request(`${this.baseUrl}/health`, {
			headers: { authorization: `Bearer ${this.token}` },
		}));
		const body = await response.json() as { ok?: boolean; version?: string; error?: string };
		if (!response.ok || body.ok !== true || typeof body.version !== "string") throw new Error(body.error ?? "Jittor health check failed");
		return { ok: true, version: body.version };
	}
}

export function connectJittorClient(paths: JittorPaths = resolveJittorPaths()): JittorClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Jittor daemon is not running; install or start jittor.service");
	const token = ensureAuthToken(paths);
	return new JittorClient(`http://${handle.host}:${handle.port}`, token);
}
