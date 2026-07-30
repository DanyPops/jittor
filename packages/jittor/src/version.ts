import { readPackageVersion } from "@danypops/vehicle-server/version";

/** Runtime package version; package.json is the single release source of truth. */
export const VERSION = readPackageVersion(new URL("../package.json", import.meta.url), "Jittor");
