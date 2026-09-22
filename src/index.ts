import { ConfigError, loadConfig, type Config } from "./config.js";
import { FatalGatewayError, PresenceClient } from "./gateway.js";
import { log } from "./log.js";

/**
 * EX_CONFIG. The systemd unit lists this under RestartPreventExitStatus, so a bad token
 * or a typo in .env stops the service instead of restarting into the same failure every
 * five seconds forever.
 */
const EXIT_CONFIG = 78;

const API_URL = "https://discord.com/api/v9/users/@me";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Confirms the token before opening a gateway connection, purely so an unusable one
 * fails with a readable message instead of a 4004 close code.
 *
 * Only an outright rejection is fatal. The original script exited on any failure at all,
 * which meant a VPS that started this before the network came up killed it on boot; a
 * transient error has to fall through and let the gateway's own retry loop handle it.
 */
async function verifyToken(config: Config): Promise<void> {
	let response: Response;
	try {
		response = await fetch(API_URL, {
			headers: { Authorization: config.token },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		log.warn(`Could not reach Discord to check the token (${(error as Error).message}). Connecting anyway.`);
		return;
	}

	if (response.status === 401 || response.status === 403) {
		throw new ConfigError(`Discord rejected the token (HTTP ${response.status}). Check DISCORD_OAUTH_TOKEN in .env.`);
	}

	if (!response.ok) {
		log.warn(`Token check returned HTTP ${response.status}. Connecting anyway.`);
	}
}

async function main(): Promise<void> {
	const config = loadConfig();
	await verifyToken(config);

	const client = new PresenceClient(config);

	// systemd sends SIGTERM on stop and restart. Closing the socket cleanly tells Discord
	// the session is over rather than leaving it to time out, and lets run() return so the
	// process exits on its own instead of waiting to be killed.
	const shutdown = (signal: string): void => {
		log.info(`Received ${signal}; shutting down.`);
		client.stop();
	};
	process.once("SIGTERM", () => shutdown("SIGTERM"));
	process.once("SIGINT", () => shutdown("SIGINT"));

	await client.run();
	log.info("Stopped.");
}

try {
	await main();
} catch (error) {
	if (error instanceof ConfigError || error instanceof FatalGatewayError) {
		log.error(error.message);
		process.exit(EXIT_CONFIG);
	}
	log.error(`Unexpected failure: ${(error as Error).stack ?? String(error)}`);
	process.exit(1);
}
