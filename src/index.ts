import { ConfigError, loadConfig } from "./config.js";
import { FatalGatewayError, PresenceClient } from "./gateway.js";
import { log } from "./log.js";

/**
 * EX_CONFIG. The systemd unit lists this under RestartPreventExitStatus, so a bad token
 * or a typo in .env stops the service instead of restarting into the same failure every
 * five seconds forever.
 */
const EXIT_CONFIG = 78;


/*
 * There is deliberately no token check before the gateway connects. It used to GET
 * /api/v9/users/@me purely so an unusable token produced a readable message instead of a
 * 4004 close code -- a cosmetic win, paid for with the worst-looking request this program
 * could make: a user token against the canonical token-validation endpoint, from a
 * datacenter IP. That is the shape of a credential checker, not of a client, and it is the
 * likeliest reason the account it belonged to was treated as compromised. The gateway
 * already reports 4004 clearly and exits 78 on it, so nothing was lost by deleting it.
 */

async function main(): Promise<void> {
	const config = loadConfig();

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
