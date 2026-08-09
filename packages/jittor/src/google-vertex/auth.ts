import { GoogleAuth } from "google-auth-library";
import { GOOGLE_ADC_TOKEN_REFRESH_SKEW_MS } from "../constants.ts";

/**
 * The only file in Jittor that imports `google-auth-library` (Jittor's first runtime dependency;
 * see docs/PROVIDER_RESEARCH.md for why ADC token acquisition -- not the Vertex/Budget API
 * surface itself -- is the one piece worth a mature dependency instead of hand-rolling: it is
 * security-sensitive OAuth/JWT/metadata-server protocol code, the exact class of thing the
 * project's own off-the-shelf-modules guidance calls out as worth not reimplementing).
 *
 * This matches the individual-GCP-project migration's "passwordless/keyless" model: Application
 * Default Credentials (a user's own `gcloud auth application-default login` session, a Compute/
 * Cloud Run metadata identity, or Workload Identity Federation), never a static service-account
 * key file. `google-auth-library` auto-detects which of those applies to the environment it runs
 * in; Jittor does not choose or configure a credential type itself.
 */
export type GoogleAdcTokenProvider = () => Promise<string>;

/** The minimal shape this module actually calls on an ADC client; matches google-auth-library's real `AuthClient`/`Credentials` fields (verified against its published `.d.ts`), kept narrow so tests can inject a fake without constructing a real `GoogleAuth`. */
export interface GoogleAdcClient {
	getAccessToken(): Promise<{ token?: string | null }>;
	credentials?: { expiry_date?: number | null };
}

export type GoogleAdcClientFactory = (scopes: readonly string[]) => Promise<GoogleAdcClient>;

async function defaultAdcClientFactory(scopes: readonly string[]): Promise<GoogleAdcClient> {
	return new GoogleAuth({ scopes: [...scopes] }).getClient();
}

/**
 * Wraps ADC token acquisition with the caching every other Jittor provider adapter skips
 * only because their upstreams don't require an OAuth exchange per call: a fresh Google access
 * token is valid for roughly an hour, and re-deriving ADC (which may itself make a metadata-server
 * or token-exchange network call) on every poll would be wasteful and, for some ADC sources,
 * rate-limited. `GOOGLE_ADC_TOKEN_REFRESH_SKEW_MS` triggers a refresh slightly before Google
 * itself would consider the cached token invalid.
 */
export function createGoogleAdcTokenProvider(
	scopes: readonly string[],
	clock: () => number = Date.now,
	clientFactory: GoogleAdcClientFactory = defaultAdcClientFactory,
): GoogleAdcTokenProvider {
	let cachedClient: GoogleAdcClient | undefined;
	let cachedToken: string | undefined;
	let cachedExpiryEpochMs = 0;

	return async function getAccessToken(): Promise<string> {
		const now = clock();
		if (cachedToken && now < cachedExpiryEpochMs - GOOGLE_ADC_TOKEN_REFRESH_SKEW_MS) return cachedToken;
		cachedClient ??= await clientFactory(scopes);
		const { token } = await cachedClient.getAccessToken();
		if (!token) throw new Error("Google Application Default Credentials did not return an access token");
		// `credentials.expiry_date` is the verified google-auth-library field (epoch ms). When a
		// credential type doesn't report one, this deliberately does not fabricate an assumed TTL --
		// it treats the token as already due for refresh, so the next call re-fetches rather than
		// caching for a guessed duration.
		const expiryDate = cachedClient.credentials?.expiry_date;
		cachedToken = token;
		cachedExpiryEpochMs = typeof expiryDate === "number" ? expiryDate : now;
		return token;
	};
}
