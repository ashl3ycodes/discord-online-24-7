import { join } from "node:path";
import type { Status } from "./types.js";

const STATUSES: readonly string[] = ["online", "idle", "dnd", "invisible"];

export interface Config {
	token: string;
	status: Status;
}

/** Raised for anything a restart cannot fix, so index.ts can exit instead of looping. */
export class ConfigError extends Error {}

/**
 * Reads .env from the project root -- one level up from the compiled dist/ this runs
 * from. Missing is not an error: under systemd the values can just as well arrive
 * through Environment= or EnvironmentFile=, and real env vars win either way because
 * loadEnvFile does not overwrite what is already set.
 */
function loadEnvFile(): void {
	try {
		process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
	} catch {
		// No .env on disk; whatever the service manager exported is all we get.
	}
}

export function loadConfig(): Config {
	loadEnvFile();

	const token = process.env.DISCORD_OAUTH_TOKEN?.trim();
	if (!token) {
		throw new ConfigError("DISCORD_OAUTH_TOKEN is empty. Copy .env.example to .env and fill it in.");
	}

	const status = process.env.STATUS?.trim() || "online";
	if (!STATUSES.includes(status)) {
		throw new ConfigError(`STATUS must be one of ${STATUSES.join(", ")} (got "${status}").`);
	}

	return {
		token,
		status: status as Status
	};
}
