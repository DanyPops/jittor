import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function typescriptFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true })
		.map(String)
		.filter((entry) => entry.endsWith(".ts"))
		.map((entry) => join(directory, entry));
}

function containsTypeScript(directory: string): boolean {
	return typescriptFiles(directory).length > 0;
}

function localDependencies(file: string): string[] {
	const imports = readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g);
	return [...imports].map((match) => relative(source, resolve(dirname(file), match[1] ?? "")).split(sep)[0] ?? "");
}

describe("Jittor screaming architecture", () => {
	it("exposes domain problems and concrete systems instead of pattern buckets", () => {
		for (const required of ["observability", "optimization", "sessions", "sqlite", "vehicle", "codex", "openrouter", "google-vertex"]) {
			expect(existsSync(join(source, required))).toBe(true);
		}
		for (const forbidden of ["domain", "ports", "adapters", "providers", "operations", "infrastructure"]) {
			expect(containsTypeScript(join(source, forbidden))).toBe(false);
		}
	});

	it("keeps domain capabilities independent of concrete integrations and delivery", () => {
		const capabilityRoots = ["observability", "optimization", "sessions"];
		const outwardRoots = new Set([
			"anthropic",
			"artificial-analysis",
			"codex",
			"google-vertex",
			"lmarena",
			"openrouter",
			"sqlite",
			"vehicle",
			"cli-commands",
		]);
		for (const root of capabilityRoots) {
			for (const file of typescriptFiles(join(source, root))) {
				expect(localDependencies(file).filter((dependency) => outwardRoots.has(dependency))).toEqual([]);
			}
		}
	});
});
