import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "src");

function containsTypeScript(directory: string): boolean {
	return existsSync(directory) && readdirSync(directory, { recursive: true }).some((entry) => String(entry).endsWith(".ts"));
}

describe("Pi Jittor screaming architecture", () => {
	it("groups collection and controls by domain purpose", () => {
		expect(containsTypeScript(join(source, "observability"))).toBe(true);
		expect(containsTypeScript(join(source, "optimization"))).toBe(true);
		expect(containsTypeScript(join(source, "capabilities"))).toBe(false);
	});

	it("keeps observation collection independent of optimization controls", () => {
		for (const entry of readdirSync(join(source, "observability"), { recursive: true })) {
			if (!String(entry).endsWith(".ts")) continue;
			expect(readFileSync(join(source, "observability", String(entry)), "utf8")).not.toMatch(/from\s+["'][^"']*optimization\//);
		}
	});
});
