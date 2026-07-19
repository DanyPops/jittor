import { LOOPBACK_HOST, MAINTENANCE_INTERVAL_MS, TELEMETRY_POLL_INTERVAL_MS } from "./constants.ts";
import { DEFAULT_POLICY, UNCONFIGURED_ROUTE } from "./config.ts";
import { SQLiteMetricStore } from "./adapters/sqlite-metric-store.ts";
import { openJittorDb } from "./db.ts";
import { createApp, JittorService } from "./service.ts";
import { JittorRouter } from "./router.ts";
import type { TelemetrySource } from "./ports/telemetry-source.ts";
import { CodexTelemetrySource, OpenRouterTelemetrySource } from "./providers/telemetry-sources.ts";
import {
	ensureAuthToken,
	removeDaemonHandle,
	resolveJittorPaths,
	writeDaemonHandle,
	type JittorPaths,
} from "./state.ts";

export interface RunningDaemon {
	host: typeof LOOPBACK_HOST;
	port: number;
	stop(): Promise<void>;
}

export function telemetrySourcesFromEnvironment(env: Record<string, string | undefined> = process.env): TelemetrySource[] {
	const sources: TelemetrySource[] = [];
	const codexAuthFile = env["JITTOR_CODEX_AUTH_FILE"];
	if (codexAuthFile) sources.push(new CodexTelemetrySource(codexAuthFile));
	const openRouterKey = env["OPENROUTER_API_KEY"];
	if (openRouterKey) sources.push(new OpenRouterTelemetrySource(openRouterKey));
	return sources;
}

export function startDaemon(
	paths: JittorPaths = resolveJittorPaths(),
	env: Record<string, string | undefined> = process.env,
): RunningDaemon {
	const token = ensureAuthToken(paths);
	const metrics = new SQLiteMetricStore(openJittorDb(paths.database));
	const sources = telemetrySourcesFromEnvironment(env);
	const router = new JittorRouter({
		metrics,
		sources,
		policy: DEFAULT_POLICY,
		routes: [],
		currentRoute: UNCONFIGURED_ROUTE,
	});
	const service = new JittorService(metrics, router);
	const app = createApp({ service, token });
	const server = Bun.serve({
		hostname: LOOPBACK_HOST,
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	const port = server.port;
	if (port === undefined) {
		server.stop(true);
		service.close();
		throw new Error("Jittor daemon failed to bind a loopback port");
	}
	writeDaemonHandle(paths, { host: LOOPBACK_HOST, port, pid: process.pid });
	const maintenance = setInterval(() => { void service.execute("service.checkpoint", {}); }, MAINTENANCE_INTERVAL_MS);
	const poll = setInterval(() => { void router.poll(); }, TELEMETRY_POLL_INTERVAL_MS);
	if (sources.length > 0) void router.poll();
	let stopped = false;
	return {
		host: LOOPBACK_HOST,
		port,
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			clearInterval(maintenance);
			clearInterval(poll);
			await server.stop(true);
			service.close();
			removeDaemonHandle(paths);
		},
	};
}

export function serveMain(): void {
	const daemon = startDaemon();
	console.error(`[jittor] listening on ${daemon.host}:${daemon.port}`);
	const stop = async (): Promise<void> => {
		await daemon.stop();
		process.exit(0);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}
