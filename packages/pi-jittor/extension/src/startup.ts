import { withDeadline } from "@danypops/jittor";
import type { JittorExtensionClient } from "./service-client.ts";
import { cacheSessionSecret, forgetSessionSecret, sessionSecretField } from "./session-identity.ts";

const STARTUP_RPC_TIMEOUT_MS = 15_000;
const MUTATIONS = new Set([
	"router.current_route",
	"router.available_routes",
	"router.pause",
	"router.resume",
	"router.override",
	"router.clear_override",
	"models.rank",
]);

interface StartupSession {
	id: string;
	controller: AbortController;
	registration?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
}

/** Owns deferred startup and the identity barrier, independently of passive telemetry readiness. */
export class SessionStartup implements JittorExtensionClient {
	private session: StartupSession | undefined;
	private stopped = false;

	constructor(private readonly transport: JittorExtensionClient) {}

	start(id: string, initialize: (client: JittorExtensionClient, isCurrent: () => boolean) => Promise<void>, onError: () => void): void {
		this.stop();
		this.stopped = false;
		const session: StartupSession = { id, controller: new AbortController() };
		this.session = session;
		const isCurrent = () => this.session === session && !session.controller.signal.aborted;
		const client: JittorExtensionClient = {
			call: async (operation, input) => {
				this.assertCurrent(session);
				const result = await this.boundedCall(operation, input, session.controller.signal);
				this.assertCurrent(session);
				return result;
			},
		};
		session.timer = setTimeout(() => {
			session.timer = undefined;
			void this.register(session)
				.then(() => {
					this.assertCurrent(session);
					return initialize(client, isCurrent);
				})
				.catch(() => {
					if (isCurrent()) onError();
				})
				.catch(() => {});
		}, 0);
		session.timer.unref?.();
	}

	async call(operation: string, input: unknown, signal?: AbortSignal): ReturnType<JittorExtensionClient["call"]> {
		const session = this.session;
		if (
			typeof input === "object" &&
			input !== null &&
			"session_id" in input &&
			(operation.startsWith("router.") || MUTATIONS.has(operation))
		) {
			if (this.stopped) throw new DOMException("Jittor session ended", "AbortError");
			if (session) {
				if (input.session_id !== session.id) throw new DOMException("Jittor session replaced", "AbortError");
				if (MUTATIONS.has(operation)) {
					await this.register(session);
					input = { ...input, ...sessionSecretField(session.id) };
				}
				this.assertCurrent(session);
				const result = await this.boundedCall(operation, input, session.controller.signal);
				this.assertCurrent(session);
				return result;
			}
		}
		return this.transport.call(operation, input, signal);
	}

	stop(): void {
		this.stopped = true;
		const session = this.session;
		this.session = undefined;
		if (!session) return;
		if (session.timer) clearTimeout(session.timer);
		session.controller.abort(new DOMException("Jittor session ended", "AbortError"));
		const secret = sessionSecretField(session.id);
		forgetSessionSecret(session.id);
		// Teardown is best-effort and bounded; a lost daemon must not hold /reload or process exit.
		if (secret.session_secret) void this.boundedCall("session.release", { session_id: session.id, ...secret }).catch(() => {});
	}

	private assertCurrent(session: StartupSession): void {
		session.controller.signal.throwIfAborted();
		if (this.session !== session) throw new DOMException("Jittor session replaced", "AbortError");
	}

	private register(session: StartupSession): Promise<void> {
		session.registration ??= this.boundedCall("session.register", { session_id: session.id }, session.controller.signal)
			.then(({ secret }) => {
				this.assertCurrent(session);
				cacheSessionSecret(session.id, secret);
			})
			.catch(() => {
				this.assertCurrent(session);
				// Preserve opt-in armor's existing best-effort registration behavior.
			});
		return session.registration;
	}

	private boundedCall(operation: string, input: unknown, signal?: AbortSignal): ReturnType<JittorExtensionClient["call"]> {
		return withDeadline((requestSignal) => this.transport.call(operation, input, requestSignal), {
			signal,
			timeoutMs: STARTUP_RPC_TIMEOUT_MS,
		});
	}
}
