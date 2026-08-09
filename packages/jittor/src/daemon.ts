import { join } from "node:path";
import { type RunningDaemon, startDaemon as startDaemonKit } from "@danypops/vehicle-server/daemon";
import { ArtificialAnalysisDirectSource } from "./artificial-analysis/benchmark-source.ts";
import { CodexTelemetrySource } from "./codex/source.ts";
import { MAINTENANCE_INTERVAL_MS, TELEMETRY_POLL_INTERVAL_MS } from "./constants.ts";
import { createGoogleAdcTokenProvider } from "./google-vertex/auth.ts";
import { GOOGLE_PUBSUB_READONLY_SCOPE } from "./google-vertex/budget-telemetry.ts";
import type { GoogleVertexMetricSource } from "./google-vertex/failures.ts";
import { GoogleVertexBudgetTelemetrySource } from "./google-vertex/source.ts";
import { LmArenaHfSource } from "./lmarena/benchmark-source.ts";
import { logEvent, logger } from "./log.ts";
import type { TelemetrySource } from "./observability/telemetry-source.ts";
import { HistoricalUsageImporter } from "./observability/usage-import.ts";
import { OpenRouterBenchmarkSource } from "./openrouter/benchmark-source.ts";
import { OpenRouterDesignArenaSource } from "./openrouter/design-arena-source.ts";
import { OpenRouterTelemetrySource } from "./openrouter/source.ts";
import { BenchmarkCatalog } from "./optimization/model-selection/benchmark.ts";
import { ModelCatalog, type ModelCatalogSource, ModelsDevCatalogSource } from "./optimization/model-selection/catalog.ts";
import { MetricModelCatalogStore } from "./optimization/model-selection/catalog-store.ts";
import { MetricBenchmarkStore } from "./optimization/model-selection/observation-store.ts";
import { EvidenceModelRanker } from "./optimization/model-selection/ranker.ts";
import type { BenchmarkSource } from "./optimization/model-selection/source.ts";
import { DEFAULT_POLICY, UNCONFIGURED_ROUTE } from "./optimization/routing/config.ts";
import { JittorRouter } from "./optimization/routing/router.ts";
import { PiSessionUsageSource } from "./pi/session-usage-source.ts";
import { SessionIdentity } from "./sessions/identity.ts";
import { openJittorDb } from "./sqlite/database.ts";
import { SQLiteMetricStore } from "./sqlite/metric-store.ts";
import { SQLiteSessionIdentityStore } from "./sqlite/session-store.ts";
import { SQLiteUsageImportStore } from "./sqlite/usage-import-store.ts";
import { ensureAuthToken, type JittorPaths, resolveJittorPaths } from "./state.ts";
import { createApp, JittorService } from "./vehicle/service.ts";

export type { RunningDaemon } from "@danypops/vehicle-server/daemon";

export function reportMaintenanceFailure(event: string, error: unknown): void {
	logEvent("error", event, { message: error instanceof Error ? error.message : String(error) });
}

// Flag name predates non-OpenRouter sources; kept as the one "opt into online benchmark
// ingestion" toggle rather than adding a second flag for the same decision.
export function benchmarkSourcesFromEnvironment(env: Record<string, string | undefined> = process.env): BenchmarkSource[] {
	if (env.JITTOR_OPENROUTER_BENCHMARKS !== "1") return [];
	const sources: BenchmarkSource[] = [new OpenRouterBenchmarkSource(), new LmArenaHfSource()];
	// Design Arena's own API needs manual approval, unlike Artificial Analysis's instant signup --
	// no direct alternative exists yet, so the OpenRouter passthrough stays.
	if (env.OPENROUTER_API_KEY) sources.push(new OpenRouterDesignArenaSource(env.OPENROUTER_API_KEY));
	if (env.ARTIFICIAL_ANALYSIS_API_KEY) sources.push(new ArtificialAnalysisDirectSource(env.ARTIFICIAL_ANALYSIS_API_KEY));
	return sources;
}

function googleVertexMetricSource(value: string | undefined): GoogleVertexMetricSource {
	if (value === undefined || value === "google-vertex") return "google-vertex";
	if (value === "anthropic-vertex") return "anthropic-vertex";
	throw new Error("JITTOR_GOOGLE_VERTEX_BUDGET_SOURCE must be google-vertex or anthropic-vertex");
}

export function modelCatalogSourceFromEnvironment(env: Record<string, string | undefined> = process.env): ModelCatalogSource | undefined {
	if (env.JITTOR_MODELS_DEV_CATALOG !== "1") return undefined;
	return new ModelsDevCatalogSource({ sourceUrl: env.JITTOR_MODELS_DEV_CATALOG_URL });
}

export function telemetrySourcesFromEnvironment(env: Record<string, string | undefined> = process.env): TelemetrySource[] {
	const sources: TelemetrySource[] = [];
	const codexAuthFile = env.JITTOR_CODEX_AUTH_FILE;
	if (codexAuthFile) sources.push(new CodexTelemetrySource(codexAuthFile));
	const openRouterKey = env.OPENROUTER_API_KEY;
	if (openRouterKey) sources.push(new OpenRouterTelemetrySource(openRouterKey));
	// Opt-in only: the Pub/Sub subscription is one-time GCP console/CLI setup outside Jittor (see
	// docs/PROVIDER_RESEARCH.md), so its absence must never attempt ADC discovery or a network call.
	const vertexBudgetSubscription = env.JITTOR_GOOGLE_VERTEX_BUDGET_SUBSCRIPTION;
	if (vertexBudgetSubscription) {
		const source = googleVertexMetricSource(env.JITTOR_GOOGLE_VERTEX_BUDGET_SOURCE);
		const tokenProvider = createGoogleAdcTokenProvider([GOOGLE_PUBSUB_READONLY_SCOPE]);
		sources.push(new GoogleVertexBudgetTelemetrySource(vertexBudgetSubscription, tokenProvider, Date.now, fetch, source));
	}
	return sources;
}

/**
 * Composition root, now built on `@danypops/vehicle-server/daemon`'s `startDaemon` for binding,
 * atomic handle write, maintenance-timer driving, and clean shutdown -- the skeleton that used to
 * be hand-rolled here (and, byte-identically, in web-spider-daemon's and papyrus's daemon.ts; see
 * daemon-kit's README). Each maintenance task still catches and classifies its own failure via
 * `reportMaintenanceFailure` (preserving Jittor's specific `checkpoint_failed`/
 * `benchmark_refresh_failed`/`telemetry_poll_failed` event taxonomy) rather than relying on
 * daemon-kit's own generic "maintenance task failed: <name>" catch, which exists as a safety net
 * for tasks that don't self-classify, not to replace a consumer's own richer classification.
 */
export async function startDaemon(
	paths: JittorPaths = resolveJittorPaths(),
	env: Record<string, string | undefined> = process.env,
): Promise<RunningDaemon> {
	const token = ensureAuthToken(paths);
	const db = openJittorDb(paths.database);
	const metrics = new SQLiteMetricStore(db);
	const sessionIdentity = new SessionIdentity(new SQLiteSessionIdentityStore(db));
	const sources = telemetrySourcesFromEnvironment(env);
	const benchmarkSources = benchmarkSourcesFromEnvironment(env);
	const benchmarkStore = new MetricBenchmarkStore(metrics);
	const benchmarks = new BenchmarkCatalog(benchmarkStore, benchmarkSources);
	const catalogSource = modelCatalogSourceFromEnvironment(env);
	const catalog = new ModelCatalog(new MetricModelCatalogStore(metrics), catalogSource);
	const modelRanker = new EvidenceModelRanker(benchmarkStore, metrics);
	const sessionsRoot = env.JITTOR_PI_SESSIONS_DIR ?? join(env.HOME ?? process.env.HOME ?? "", ".pi", "agent", "sessions");
	const usageImporter = new HistoricalUsageImporter(new PiSessionUsageSource(sessionsRoot), new SQLiteUsageImportStore(db));
	const router = new JittorRouter({
		metrics,
		sources,
		policy: DEFAULT_POLICY,
		routes: [],
		currentRoute: UNCONFIGURED_ROUTE,
	});
	const service = new JittorService(metrics, router, benchmarks, modelRanker, sessionIdentity, undefined, catalog, usageImporter);

	const daemon = await startDaemonKit({
		daemonLabel: "Jittor",
		handlePath: paths.handle,
		logger,
		buildApp: () => createApp({ service, token }),
		maintenanceTasks: [
			{
				name: "checkpoint",
				intervalMs: MAINTENANCE_INTERVAL_MS,
				run: async () => {
					await service.execute("service.checkpoint", {}).catch((error) => reportMaintenanceFailure("checkpoint_failed", error));
				},
			},
			{
				name: "benchmark-refresh",
				intervalMs: MAINTENANCE_INTERVAL_MS,
				run: async () => {
					await benchmarks.refresh().catch((error) => reportMaintenanceFailure("benchmark_refresh_failed", error));
				},
			},
			{
				name: "catalog-refresh",
				intervalMs: MAINTENANCE_INTERVAL_MS,
				run: async () => {
					await catalog.refresh().catch((error) => reportMaintenanceFailure("catalog_refresh_failed", error));
				},
			},
			{
				name: "telemetry-poll",
				intervalMs: TELEMETRY_POLL_INTERVAL_MS,
				run: async () => {
					await router.poll().catch((error) => reportMaintenanceFailure("telemetry_poll_failed", error));
				},
			},
		],
		onShutdown: () => {
			service.close();
		},
	});

	if (sources.length > 0) router.poll().catch((error) => reportMaintenanceFailure("telemetry_poll_failed", error));
	if (benchmarkSources.length > 0) benchmarks.refresh().catch((error) => reportMaintenanceFailure("benchmark_refresh_failed", error));
	if (catalogSource) catalog.refresh().catch((error) => reportMaintenanceFailure("catalog_refresh_failed", error));

	return daemon;
}

export async function serveMain(): Promise<void> {
	const daemon = await startDaemon();
	console.error(`[jittor] listening on ${daemon.host}:${daemon.port}`);
	const stop = async (): Promise<void> => {
		await daemon.stop();
		process.exit(0);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}
