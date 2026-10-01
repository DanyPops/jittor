import { afterEach, describe, expect, it } from "bun:test";
import type { JittorExtensionClient } from "../extension/src/service-client.ts";
import { sessionSecretField } from "../extension/src/session-identity.ts";
import { SessionStartup } from "../extension/src/startup.ts";

const sessions: SessionStartup[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.stop();
});

function startup(call: JittorExtensionClient["call"]): SessionStartup {
	const session = new SessionStartup({ call });
	sessions.push(session);
	return session;
}

async function drain(): Promise<void> {
	await Bun.sleep(5);
}

describe("deferred session startup", () => {
	it("returns before a permanently pending registration and cancels it on shutdown", async () => {
		let signal: AbortSignal | undefined;
		let initialized = false;
		let calls = 0;
		const session = startup(async (_operation, _input, requestSignal) => {
			calls++;
			signal = requestSignal;
			return new Promise(() => {});
		});
		expect(
			session.start(
				"pending",
				async () => {
					initialized = true;
				},
				() => {},
			),
		).toBeUndefined();
		expect(calls).toBe(0);
		await drain();
		expect(calls).toBe(1);
		expect(initialized).toBe(false);
		session.stop();
		expect(signal?.aborted).toBe(true);
	});

	it("cancels scheduled startup before making any daemon call", async () => {
		let calls = 0;
		const session = startup(async () => {
			calls++;
			return {};
		});
		session.start(
			"canceled",
			async () => {},
			() => {},
		);
		session.stop();
		session.stop();
		await drain();
		expect(calls).toBe(0);
	});

	it("shares registration with early mutations, adds the resolved secret, and keeps telemetry independent", async () => {
		const registration = Promise.withResolvers<{ secret: string }>();
		const polling = Promise.withResolvers<void>();
		const calls: Array<{ operation: string; input: unknown }> = [];
		const session = startup(async (operation, input) => {
			calls.push({ operation, input });
			if (operation === "session.register") return registration.promise;
			if (operation === "telemetry.poll") return polling.promise;
			return {};
		});
		session.start(
			"early",
			async (client) => {
				await client.call("telemetry.poll", {});
			},
			() => {},
		);
		const mutation = session.call("router.current_route", { session_id: "early", model: "new" });
		const otherMutation = session.call("router.available_routes", { session_id: "early", routes: [] });
		await drain();
		expect(calls.map(({ operation }) => operation)).toEqual(["session.register"]);
		registration.resolve({ secret: "early-secret" });
		await Promise.all([mutation, otherMutation]);
		await drain();
		expect(calls.filter(({ operation }) => operation === "session.register")).toHaveLength(1);
		expect(
			calls
				.filter(({ operation }) => operation.startsWith("router."))
				.every(({ input }) => (input as { session_secret: string }).session_secret === "early-secret"),
		).toBe(true);
		expect(calls.some(({ operation }) => operation === "telemetry.poll")).toBe(true);
		session.stop();
		expect(sessionSecretField("early")).toEqual({});
		polling.resolve();
		await drain();
		expect(calls).toContainEqual({ operation: "session.release", input: { session_id: "early", session_secret: "early-secret" } });
	});

	it.each([false, true])("ignores late telemetry success/failure after replacement (reject=%s)", async (reject) => {
		const oldPoll = Promise.withResolvers<void>();
		let pollSignal: AbortSignal | undefined;
		const rendered: string[] = [];
		const errors: string[] = [];
		let polls = 0;
		const session = startup(async (operation, input, signal) => {
			if (operation === "session.register") return { secret: `${(input as { session_id: string }).session_id}-secret` };
			if (operation === "telemetry.poll" && ++polls === 1) {
				pollSignal = signal;
				return oldPoll.promise;
			}
			return {};
		});
		const initialize = (id: string) => async (client: JittorExtensionClient, isCurrent: () => boolean) => {
			await client.call("telemetry.poll", {});
			if (isCurrent()) rendered.push(id);
		};
		session.start("old", initialize("old"), () => errors.push("old"));
		await drain();
		session.start("new", initialize("new"), () => errors.push("new"));
		await drain();
		expect(pollSignal?.aborted).toBe(true);
		if (reject) oldPoll.reject(new Error("late failure"));
		else oldPoll.resolve();
		await drain();
		expect(rendered).toEqual(["new"]);
		expect(errors).toEqual([]);
		expect(sessionSecretField("old")).toEqual({});
		expect(sessionSecretField("new")).toEqual({ session_secret: "new-secret" });
	});

	it("does not cache a late registration or follow it with mutations after shutdown", async () => {
		const registration = Promise.withResolvers<{ secret: string }>();
		let initialized = false;
		const session = startup(async () => registration.promise);
		session.start(
			"late",
			async () => {
				initialized = true;
			},
			() => {},
		);
		await drain();
		session.stop();
		registration.resolve({ secret: "late-secret" });
		await drain();
		expect(sessionSecretField("late")).toEqual({});
		expect(initialized).toBe(false);
		await expect(session.call("router.pause", { session_id: "late" })).rejects.toMatchObject({ name: "AbortError" });
	});

	it("keeps the existing best-effort registration fallback and reports active initialization failure once", async () => {
		let errors = 0;
		let mutation: unknown;
		const session = startup(async (operation, input) => {
			if (operation === "session.register" || operation === "telemetry.poll") throw new Error("offline");
			mutation = input;
			return {};
		});
		session.start(
			"offline",
			async (client) => {
				await client.call("telemetry.poll", {});
			},
			() => {
				errors++;
			},
		);
		await session.call("router.pause", { session_id: "offline" });
		expect(mutation).toEqual({ session_id: "offline" });
		await drain();
		expect(errors).toBe(1);
	});
});
