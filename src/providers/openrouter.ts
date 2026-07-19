import {
	parseOpenRouterAnalytics,
	parseOpenRouterGeneration,
	parseOpenRouterKey,
	parseOpenRouterModels,
	type OpenRouterAnalyticsResult,
	type OpenRouterGeneration,
	type OpenRouterKeySnapshot,
	type OpenRouterModel,
} from "./openrouter-contracts.ts";

export {
	openRouterUsageMetrics,
	parseOpenRouterUsage,
	type OpenRouterAnalyticsResult,
	type OpenRouterGeneration,
	type OpenRouterKeySnapshot,
	type OpenRouterModel,
	type OpenRouterUsage,
	type OpenRouterUsageContext,
} from "./openrouter-contracts.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export type OpenRouterTransport = (request: Request) => Promise<Response>;

export class OpenRouterTelemetryAdapter {
	private managementCapability: boolean | undefined;

	constructor(
		private readonly apiKey: string,
		private readonly transport: OpenRouterTransport = fetch,
		private readonly baseUrl = OPENROUTER_BASE_URL,
	) {
		if (apiKey.length === 0) throw new Error("OpenRouter API key is required");
	}

	async readKey(observedAt = Date.now()): Promise<OpenRouterKeySnapshot> {
		const snapshot = parseOpenRouterKey(await this.request("/key"), observedAt);
		this.managementCapability = snapshot.management;
		return snapshot;
	}

	async listModels(): Promise<OpenRouterModel[]> {
		return parseOpenRouterModels(await this.request("/models"));
	}

	async getGeneration(id: string): Promise<OpenRouterGeneration> {
		if (id.length === 0) throw new Error("generation id is required");
		return parseOpenRouterGeneration(await this.request(`/generation?id=${encodeURIComponent(id)}`));
	}

	async queryAnalytics(query: Record<string, unknown>): Promise<OpenRouterAnalyticsResult> {
		if (this.managementCapability !== true) throw new Error("OpenRouter analytics requires a detected management key");
		return parseOpenRouterAnalytics(await this.request("/analytics/query", {
			method: "POST",
			body: JSON.stringify(query),
		}));
	}

	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const response = await this.transport(new Request(`${this.baseUrl}${path}`, {
			...init,
			headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...init.headers },
		}));
		if (!response.ok) {
			const retryAfter = response.headers.get("retry-after");
			throw new Error(`OpenRouter ${path.split("?")[0]} failed with HTTP ${response.status}${retryAfter ? `; retry after ${retryAfter}` : ""}`);
		}
		return response.json();
	}
}
