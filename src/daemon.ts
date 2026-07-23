import { LOOPBACK_HOST, MAINTENANCE_INTERVAL_MS, TELEMETRY_POLL_INTERVAL_MS } from "./constants.ts";
import { DEFAULT_POLICY, UNCONFIGURED_ROUTE } from "./config.ts";
import { SQLiteMetricStore } from "./adapters/sqlite-metric-store.ts";
import { MetricBenchmarkStore } from "./adapters/metric-benchmark-store.ts";
import { OpenRouterBenchmarkIndexSource } from "./adapters/openrouter-benchmark-index-source.ts";
import { OpenRouterBenchmarkSource } from "./adapters/openrouter-benchmark-source.ts";
import { openJittorDb } from "./db.ts";
import { BenchmarkCatalog } from "./domain/benchmark.ts";
import { EvidenceModelRanker } from "./domain/model-ranking-service.ts";
import { createApp, JittorService } from "./service.ts";
import { JittorRouter } from "./router.ts";
import type { BenchmarkSource } from "./ports/benchmark-source.ts";
import type { TelemetrySource } from "./ports/telemetry-source.ts";
import { CodexTelemetrySource, GoogleVertexBudgetTelemetrySource, OpenRouterTelemetrySource } from "./providers/telemetry-sources.ts";
import { createGoogleAdcTokenProvider } from "./providers/google-adc-auth.ts";
import { GOOGLE_PUBSUB_READONLY_SCOPE } from "./providers/google-vertex-budget.ts";
import type { GoogleVertexMetricSource } from "./providers/google-vertex-contracts.ts";
import {
	ensureAuthToken,
	removeDaemonHandle,
	resolveJittorPaths,
	writeDaemonHandle,
	type JittorPaths,
} from "./state.ts";
import { logEvent } from "./log.ts";

export function reportMaintenanceFailure(event: string, error: unknown): void {
	logEvent("error", event, { message: error instanceof Error ? error.message : String(error) });
}

export interface RunningDaemon {
	host: typeof LOOPBACK_HOST;
	port: number;
	stop(): Promise<void>;
}

export function benchmarkSourcesFromEnvironment(env: Record<string, string | undefined> = process.env): BenchmarkSource[] {
	if (env["JITTOR_OPENROUTER_BENCHMARKS"] !== "1") return [];
	const sources: BenchmarkSource[] = [new OpenRouterBenchmarkSource()];
	if (env["OPENROUTER_API_KEY"]) sources.push(new OpenRouterBenchmarkIndexSource(env["OPENROUTER_API_KEY"]));
	return sources;
}

export function telemetrySourcesFromEnvironment(env: Record<string, string | undefined> = process.env): TelemetrySource[] {
	const sources: TelemetrySource[] = [];
	const codexAuthFile = env["JITTOR_CODEX_AUTH_FILE"];
	if (codexAuthFile) sources.push(new CodexTelemetrySource(codexAuthFile));
	const openRouterKey = env["OPENROUTER_API_KEY"];
	if (openRouterKey) sources.push(new OpenRouterTelemetrySource(openRouterKey));
	// Opt-in only: the Pub/Sub subscription is one-time GCP console/CLI setup outside Jittor (see
	// docs/PROVIDER_RESEARCH.md), so its absence must never attempt ADC discovery or a network call.
	const vertexBudgetSubscription = env["JITTOR_GOOGLE_VERTEX_BUDGET_SUBSCRIPTION"];
	if (vertexBudgetSubscription) {
		const source = (env["JITTOR_GOOGLE_VERTEX_BUDGET_SOURCE"] ?? "google-vertex") as GoogleVertexMetricSource;
		const tokenProvider = createGoogleAdcTokenProvider([GOOGLE_PUBSUB_READONLY_SCOPE]);
		sources.push(new GoogleVertexBudgetTelemetrySource(vertexBudgetSubscription, tokenProvider, Date.now, fetch, source));
	}
	return sources;
}

export function startDaemon(
	paths: JittorPaths = resolveJittorPaths(),
	env: Record<string, string | undefined> = process.env,
): RunningDaemon {
	const token = ensureAuthToken(paths);
	const metrics = new SQLiteMetricStore(openJittorDb(paths.database));
	const sources = telemetrySourcesFromEnvironment(env);
	const benchmarkSources = benchmarkSourcesFromEnvironment(env);
	const benchmarkStore = new MetricBenchmarkStore(metrics);
	const benchmarks = new BenchmarkCatalog(benchmarkStore, benchmarkSources);
	const modelRanker = new EvidenceModelRanker(benchmarkStore, metrics);
	const router = new JittorRouter({
		metrics,
		sources,
		policy: DEFAULT_POLICY,
		routes: [],
		currentRoute: UNCONFIGURED_ROUTE,
	});
	const service = new JittorService(metrics, router, benchmarks, modelRanker);
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
	const maintenance = setInterval(() => {
		service.execute("service.checkpoint", {}).catch((error) => reportMaintenanceFailure("checkpoint_failed", error));
		benchmarks.refresh().catch((error) => reportMaintenanceFailure("benchmark_refresh_failed", error));
	}, MAINTENANCE_INTERVAL_MS);
	const poll = setInterval(() => {
		router.poll().catch((error) => reportMaintenanceFailure("telemetry_poll_failed", error));
	}, TELEMETRY_POLL_INTERVAL_MS);
	if (sources.length > 0) router.poll().catch((error) => reportMaintenanceFailure("telemetry_poll_failed", error));
	if (benchmarkSources.length > 0) benchmarks.refresh().catch((error) => reportMaintenanceFailure("benchmark_refresh_failed", error));
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
