/**
 * The full argument grammar for /jittor, as one small data table -- the single source of truth
 * both jittorUsageError (validation) and jittorArgumentCompletions (tab-completion) read from, so
 * the two can never drift apart (a phrase added to one is automatically valid/completable in the
 * other). /jittor's own registerCommand handler in index.ts owns dispatching a validated phrase to
 * its real behavior; this module only ever answers "is this a real phrase" and "what could this
 * become".
 *
 * `benchmarks` is deliberately excluded from LEAF_PHRASES: its own domain/type combinatorics
 * (TASK_DOMAINS x TASK_TYPES, either order) already have a dedicated, tested malformed-usage
 * branch in index.ts with its own specific error message -- this module defers to it entirely
 * for validation, and only mirrors its real phrase space for completions.
 */
import { TASK_DOMAINS, TASK_TYPES } from "@danypops/jittor";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const JITTOR_TOP_LEVEL_COMMANDS = [
	"settings",
	"status",
	"benchmarks",
	"cache",
	"outcome",
	"recovery",
	"on",
	"off",
	"footer",
	"context",
] as const;

/** Every real, currently-supported phrase EXCEPT benchmarks (see module doc comment). */
const LEAF_PHRASES = [
	"",
	"settings",
	"status",
	"cache",
	"context",
	"on",
	"enable",
	"off",
	"disable",
	"outcome accepted",
	"outcome rejected",
	"recovery",
	"recovery status",
	"recovery on",
	"recovery enable",
	"recovery off",
	"recovery disable",
	"recovery cancel",
	"footer on",
	"footer enable",
	"footer off",
	"footer disable",
] as const;

/** Real benchmarks phrases: bare, one axis alone, or both axes in either accepted word order -- mirrors index.ts's own lenient two-word-any-order parsing, for completions only. */
function benchmarksPhrases(): string[] {
	const phrases: string[] = ["benchmarks"];
	for (const domain of TASK_DOMAINS) phrases.push(`benchmarks ${domain}`);
	for (const type of TASK_TYPES) phrases.push(`benchmarks ${type}`);
	for (const domain of TASK_DOMAINS) {
		for (const type of TASK_TYPES) {
			phrases.push(`benchmarks ${domain} ${type}`, `benchmarks ${type} ${domain}`);
		}
	}
	return phrases;
}

/**
 * null when `action` (already trimmed/lowercased by the caller, matching index.ts's own
 * convention) is a real, currently-supported phrase; otherwise a human-readable message naming
 * exactly what was wrong and what the real alternatives are -- never a silent fallback to
 * unrelated behavior (the bug class this replaces: an unrecognized word, or a valid command with
 * an unrecognized trailing argument, used to silently open the status panel instead).
 */
export function jittorUsageError(action: string): string | null {
	if ((LEAF_PHRASES as readonly string[]).includes(action)) return null;
	if (action === "benchmarks" || action.startsWith("benchmarks ")) return null;

	const words = action.split(/\s+/).filter(Boolean);
	const firstWord = words[0]!;
	if (!(JITTOR_TOP_LEVEL_COMMANDS as readonly string[]).includes(firstWord)) {
		return `Unknown /jittor command "${firstWord}". Allowed: ${JITTOR_TOP_LEVEL_COMMANDS.join(", ")}.`;
	}
	const subPhrases = LEAF_PHRASES.filter((phrase) => phrase.startsWith(`${firstWord} `));
	if (subPhrases.length === 0) return `/jittor ${firstWord} does not take any arguments.`;
	const subArguments = subPhrases.map((phrase) => phrase.slice(firstWord.length + 1));
	return `Unknown /jittor ${firstWord} argument "${words.slice(1).join(" ")}". Allowed: ${subArguments.join(", ")}.`;
}

let cachedCompletionPhrases: string[] | undefined;
function completionPhrases(): string[] {
	if (!cachedCompletionPhrases) cachedCompletionPhrases = [...LEAF_PHRASES.filter((phrase) => phrase.length > 0), ...benchmarksPhrases()];
	return cachedCompletionPhrases;
}

/**
 * Every real phrase (see completionPhrases) that could still result from typing more after
 * `argumentPrefix`, matching pi-tui's own SlashCommand.getArgumentCompletions contract: `value` is
 * the FULL replacement for the entire argument text typed so far (pi-tui's own applyCompletion
 * replaces the whole prefix span with it, not just the trailing word), so every candidate here is a
 * complete phrase, not a per-word delta. Matching is case-insensitive on the typed prefix (a human
 * may capitalize while typing); returned values are always canonical lowercase.
 */
export function jittorArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const needle = argumentPrefix.toLowerCase();
	const matches = completionPhrases().filter((phrase) => phrase.startsWith(needle));
	if (matches.length === 0) return null;
	return matches.map((value) => ({ value, label: value }));
}
