import { callAndPrint, humanField, type CliDependencies } from "./support.ts";

export const SESSION_USAGE_LINES = [
	"  session register --session-id <id> [--json]",
	"  session release --session-id <id> [--session-secret <secret>] [--json]",
];

interface SessionArgs { input: { session_id: string; session_secret?: string }; json: boolean }

function parseSessionArgs(args: string[]): SessionArgs | null {
	let json = false;
	let sessionId: string | undefined;
	let sessionSecret: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") { json = true; continue; }
		if (!["--session-id", "--session-secret"].includes(argument ?? "")) return null;
		const raw = args[++index];
		if (raw === undefined || raw.length === 0) return null;
		if (argument === "--session-id") sessionId = raw;
		else sessionSecret = raw;
	}
	if (sessionId === undefined) return null;
	return { input: { session_id: sessionId, ...(sessionSecret ? { session_secret: sessionSecret } : {}) }, json };
}

export function formatSessionRegistration(result: { sessionId: string; secret: string }): string {
	return `Session registered: ${humanField(result.sessionId)} · secret ${humanField(result.secret)} (shown once; keep it to mutate this session's router state)`;
}

export function formatSessionRelease(result: { released: boolean }): string {
	return result.released ? "Session released" : "Session was not registered, or the secret did not match";
}

export async function runSessionCommand(action: string | undefined, rest: string[], deps: CliDependencies, usage: () => number): Promise<number> {
	if (action !== "register" && action !== "release") return usage();
	const parsed = parseSessionArgs(rest);
	if (!parsed) return usage();
	return action === "register"
		? callAndPrint(deps, "session.register", parsed.input, parsed.json, formatSessionRegistration)
		: callAndPrint(deps, "session.release", parsed.input, parsed.json, formatSessionRelease);
}
