import { describe, expect, it } from "bun:test";
import { jittorArgumentCompletions, jittorUsageError } from "../extension/src/jittor-command.ts";

const VALID_PHRASES = [
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
];

describe("jittorUsageError", () => {
	for (const phrase of VALID_PHRASES) {
		it(`accepts the real, already-supported phrase "${phrase}"`, () => {
			expect(jittorUsageError(phrase)).toBeNull();
		});
	}

	it("always delegates benchmarks validation to its own dedicated branch, even for a malformed benchmarks phrase", () => {
		expect(jittorUsageError("benchmarks")).toBeNull();
		expect(jittorUsageError("benchmarks coding")).toBeNull();
		expect(jittorUsageError("benchmarks coding research")).toBeNull();
		expect(jittorUsageError("benchmarks research coding")).toBeNull();
		expect(jittorUsageError("benchmarks bogus")).toBeNull();
		expect(jittorUsageError("benchmarks coding coding")).toBeNull();
	});

	it("rejects an unrecognized top-level word, listing every real top-level command", () => {
		const message = jittorUsageError("cach");
		expect(message).toContain('Unknown /jittor command "cach"');
		expect(message).toContain("settings");
		expect(message).toContain("status");
		expect(message).toContain("benchmarks");
		expect(message).toContain("cache");
		expect(message).toContain("outcome");
		expect(message).toContain("recovery");
		expect(message).toContain("on");
		expect(message).toContain("off");
		expect(message).toContain("footer");
		expect(message).toContain("context");
	});

	it("rejects an unrecognized sub-argument for a recognized command, listing that command's own real allowed sub-arguments", () => {
		const message = jittorUsageError("recovery bogus");
		expect(message).toContain('Unknown /jittor recovery argument "bogus"');
		expect(message).toContain("status");
		expect(message).toContain("on");
		expect(message).toContain("enable");
		expect(message).toContain("off");
		expect(message).toContain("disable");
		expect(message).toContain("cancel");
		// Never lists a *different* command's own sub-arguments -- footer's "on"/"off" phrases
		// happen to share literal words with recovery's, but the message must stay scoped to recovery.
		expect(message).not.toContain("footer");
	});

	it("rejects an unrecognized footer sub-argument the same way", () => {
		const message = jittorUsageError("footer bogus");
		expect(message).toContain('Unknown /jittor footer argument "bogus"');
		expect(message).toContain("on");
		expect(message).toContain("off");
	});

	it("rejects an unrecognized outcome sub-argument the same way", () => {
		const message = jittorUsageError("outcome bogus");
		expect(message).toContain('Unknown /jittor outcome argument "bogus"');
		expect(message).toContain("accepted");
		expect(message).toContain("rejected");
	});

	it("rejects trailing extra words on a command that takes no arguments at all, instead of silently opening an unrelated panel", () => {
		expect(jittorUsageError("cache foo")).toBe("/jittor cache does not take any arguments.");
		expect(jittorUsageError("status foo")).toBe("/jittor status does not take any arguments.");
		expect(jittorUsageError("context foo")).toBe("/jittor context does not take any arguments.");
		expect(jittorUsageError("settings foo")).toBe("/jittor settings does not take any arguments.");
		expect(jittorUsageError("on foo")).toBe("/jittor on does not take any arguments.");
	});
});

describe("jittorArgumentCompletions", () => {
	it("returns null (no completions) for a prefix nothing matches", () => {
		expect(jittorArgumentCompletions("zzz")).toBeNull();
	});

	it("returns every top-level command plus their sub-phrases for an empty prefix", () => {
		const items = jittorArgumentCompletions("");
		expect(items).not.toBeNull();
		const values = items!.map((item) => item.value);
		expect(values).toContain("settings");
		expect(values).toContain("status");
		expect(values).toContain("cache");
		expect(values).toContain("context");
		expect(values).toContain("recovery");
		expect(values).toContain("recovery on");
		expect(values).toContain("footer on");
		expect(values).toContain("outcome accepted");
		expect(values).toContain("benchmarks");
		// Never offers completing to the empty string itself -- nothing to "complete" there.
		expect(values).not.toContain("");
	});

	it("narrows to only the matching sub-phrases once a command word is typed", () => {
		const values = jittorArgumentCompletions("recovery ")!.map((item) => item.value);
		expect(values.sort()).toEqual(
			["recovery cancel", "recovery disable", "recovery enable", "recovery off", "recovery on", "recovery status"].sort(),
		);
	});

	it("is case-insensitive on the typed prefix but returns canonical lowercase values", () => {
		const values = jittorArgumentCompletions("REC")!.map((item) => item.value);
		expect(values.length).toBeGreaterThan(0);
		expect(values.every((value) => value === value.toLowerCase())).toBe(true);
	});

	it("includes real benchmarks domain/type combinations, prefix-matched", () => {
		const codingPrefixed = jittorArgumentCompletions("benchmarks cod")!.map((item) => item.value);
		expect(codingPrefixed).toContain("benchmarks coding");
		expect(codingPrefixed).toContain("benchmarks coding research");
		expect(codingPrefixed).not.toContain("benchmarks research coding"); // wrong word order for this prefix
	});

	it("accepts either accepted word order for a two-axis benchmarks phrase, matching index.ts's own lenient parsing", () => {
		const all = jittorArgumentCompletions("benchmarks")!.map((item) => item.value);
		expect(all).toContain("benchmarks coding research");
		expect(all).toContain("benchmarks research coding");
	});

	it("every returned value would itself pass jittorUsageError, or is a real benchmarks phrase -- completions never suggest an invalid command", () => {
		const values = jittorArgumentCompletions("")!.map((item) => item.value);
		for (const value of values) {
			if (value === "benchmarks" || value.startsWith("benchmarks ")) continue;
			expect(jittorUsageError(value)).toBeNull();
		}
	});
});
