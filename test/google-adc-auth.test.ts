import { describe, expect, it } from "bun:test";
import { createGoogleAdcTokenProvider, type GoogleAdcClient, type GoogleAdcClientFactory } from "../src/providers/google-adc-auth.ts";

function fakeFactory(client: GoogleAdcClient, calls: string[][]): GoogleAdcClientFactory {
	return async (scopes) => { calls.push([...scopes]); return client; };
}

describe("createGoogleAdcTokenProvider", () => {
	it("requests ADC with the given scopes exactly once and caches the token until near expiry", async () => {
		const calls: string[][] = [];
		let now = 0;
		let issued = 0;
		const client: GoogleAdcClient = {
			async getAccessToken() { issued += 1; return { token: `token-${issued}`, }; },
			credentials: { expiry_date: 3_600_000 },
		};
		const getAccessToken = createGoogleAdcTokenProvider(["https://www.googleapis.com/auth/pubsub"], () => now, fakeFactory(client, calls));

		expect(await getAccessToken()).toBe("token-1");
		expect(await getAccessToken()).toBe("token-1");
		expect(calls).toEqual([["https://www.googleapis.com/auth/pubsub"]]);

		now = 3_600_000 - 1_000;
		expect(await getAccessToken()).toBe("token-2");
	});

	it("throws when ADC yields no token instead of returning an empty credential", async () => {
		const client: GoogleAdcClient = { async getAccessToken() { return { token: null }; } };
		const getAccessToken = createGoogleAdcTokenProvider(["scope"], () => 0, fakeFactory(client, []));
		await expect(getAccessToken()).rejects.toThrow(/did not return an access token/);
	});

	it("never fabricates a cache TTL when a credential type reports no expiry -- always refetches instead", async () => {
		let now = 0;
		let issued = 0;
		const client: GoogleAdcClient = { async getAccessToken() { issued += 1; return { token: `token-${issued}` }; } };
		const getAccessToken = createGoogleAdcTokenProvider(["scope"], () => now, fakeFactory(client, []));

		expect(await getAccessToken()).toBe("token-1");
		now = 1;
		expect(await getAccessToken()).toBe("token-2");
	});
});
