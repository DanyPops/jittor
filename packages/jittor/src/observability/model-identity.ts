import { BENCHMARK_IDENTITY_MAX_CHARACTERS } from "../constants.ts";

const VERSION_SUFFIX = /-(\d{4}-\d{2}-\d{2})$/;

export interface ModelIdentity {
	provider: string;
	model: string;
	version: string | null;
	canonical: string;
	aliases: string[];
}

function identityText(value: string, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
	const normalized = value.trim().toLowerCase();
	if (normalized.length > BENCHMARK_IDENTITY_MAX_CHARACTERS) throw new Error(`${name} exceeds the length limit`);
	if (/\p{Cc}/u.test(normalized)) throw new Error(`${name} contains control characters`);
	return normalized;
}

function identityPart(value: string, name: string, allowPath = false): string {
	const normalized = identityText(value, name);
	const pattern = allowPath ? /^[a-z0-9][a-z0-9._:+/-]*$/ : /^[a-z0-9][a-z0-9._:+-]*$/;
	if (!pattern.test(normalized) || normalized.includes("//")) throw new Error(`${name} is invalid`);
	return normalized;
}

export function normalizeModelIdentity(provider: string, model: string, aliases: string[] = []): ModelIdentity {
	const normalizedProvider = identityPart(provider, "provider");
	const normalizedModel = identityPart(model, "model", true);
	const canonical = `${normalizedProvider}/${normalizedModel}`;
	const normalizedAliases = [...new Set(aliases.map((alias) => identityText(alias, "alias")))]
		.filter((alias) => alias !== canonical)
		.sort();
	return {
		provider: normalizedProvider,
		model: normalizedModel,
		version: VERSION_SUFFIX.exec(normalizedModel)?.[1] ?? null,
		canonical,
		aliases: normalizedAliases,
	};
}
