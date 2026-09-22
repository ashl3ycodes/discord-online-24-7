import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.js";
import type { Config } from "./config.js";
import { Opcode, type HelloData, type Payload, type Presence, type ReadyData } from "./types.js";

const ENTRY_URL = "wss://gateway.discord.gg/?v=9&encoding=json";

/** Discord asks for an immediate retry after a resumable drop, and backoff after a fresh one. */
const RESUME_DELAY_MS = 1_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;

/** Our own close code for a socket that stopped acknowledging heartbeats. */
const CLOSE_ZOMBIE = 4000;

/**
 * Close codes after which Discord refuses a RESUME, so the session has to be rebuilt
 * from a fresh IDENTIFY. 1000/1001 are in here because a clean close invalidates the
 * session server-side; everything absent from this set (notably the abnormal 1006 that
 * a dropped TCP connection produces) is worth trying to resume.
 */
const UNRESUMABLE = new Set([1000, 1001, 4007, 4009, 4010, 4011, 4012, 4013, 4014]);

/** Authentication failed: the token is revoked or wrong, and no amount of retrying fixes it. */
const CLOSE_AUTH_FAILED = 4004;

export class FatalGatewayError extends Error {}

interface Disconnect {
	code: number;
	reason: string;
}

interface Session {
	id: string;
	resumeUrl: string;
	sequence: number | null;
}

export class PresenceClient {
	private readonly config: Config;
	private session: Session | null = null;
	private failures = 0;
	private stopping = false;
	private socket: WebSocket | null = null;

	public constructor(config: Config) {
		this.config = config;
	}

	/** Runs until stop() is called or the token turns out to be unusable. */
	public async run(): Promise<void> {
		while (!this.stopping) {
			const resuming = this.session !== null;
			const url = this.session?.resumeUrl ?? ENTRY_URL;

			const { code, reason } = await this.connect(url, resuming);
			if (this.stopping) {
				return;
			}

			if (code === CLOSE_AUTH_FAILED) {
				throw new FatalGatewayError("Discord rejected the token (4004). It is revoked or malformed.");
			}

			if (UNRESUMABLE.has(code)) {
				this.session = null;
			}

			// A resume costs nothing and does not spend an IDENTIFY, so it retries almost at
			// once. A fresh connection backs off -- repeated IDENTIFYs are both rate limited
			// and the pattern Discord watches for.
			const delay = this.session ? RESUME_DELAY_MS : this.backoff();
			log.warn(`Disconnected (${code}${reason ? `: ${reason}` : ""}). Reconnecting in ${Math.round(delay / 1000)}s.`);
			await sleep(delay);
		}
	}

	/** Closes the live socket and lets run() fall out of its loop. */
	public stop(): void {
		this.stopping = true;
		this.socket?.close(1000, "shutting down");
	}

	/**
	 * Full exponential backoff with jitter. The jitter matters on a VPS that boots several
	 * services at once: without it every retry lands on the same tick.
	 */
	private backoff(): number {
		const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** this.failures, BACKOFF_CAP_MS);
		this.failures++;
		return BACKOFF_BASE_MS + Math.random() * (ceiling - BACKOFF_BASE_MS);
	}

	private connect(url: string, resuming: boolean): Promise<Disconnect> {
		return new Promise<Disconnect>((resolve) => {
			const socket = new WebSocket(url);
			this.socket = socket;

			let heartbeatTimer: NodeJS.Timeout | undefined;
			let acknowledged = true;
			let settled = false;

			// Every exit path funnels through here so a socket can never leave its heartbeat
			// timer running, and so a late close event after a zombie kill cannot resolve the
			// promise a second time and start a duplicate connection.
			const finish = (code: number, reason: string): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(heartbeatTimer);
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				if (this.socket === socket) {
					this.socket = null;
				}
				resolve({ code, reason });
			};

			const send = (op: Opcode, d: unknown): void => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ op, d }));
				}
			};

			const beat = (): void => {
				// The previous heartbeat was never acknowledged. The TCP connection can stay up
				// long after the gateway has stopped listening -- a dead NAT mapping does exactly
				// this -- and the original script would sit in that state believing it was still
				// online. Treat silence as death and rebuild the connection.
				if (!acknowledged) {
					log.warn("Heartbeat went unacknowledged; the connection is a zombie.");
					socket.close(CLOSE_ZOMBIE, "heartbeat timeout");
					finish(CLOSE_ZOMBIE, "heartbeat timeout");
					return;
				}
				acknowledged = false;
				send(Opcode.Heartbeat, this.session?.sequence ?? null);
			};

			socket.onerror = (): void => {
				// Without this handler a mid-connect ECONNRESET becomes an unhandled error event.
				// The close event follows and carries the detail, so there is nothing to do here
				// beyond keeping the process alive long enough to receive it.
			};

			// Both event types are inferred from the handler rather than named outright:
			// CloseEvent is not a global in every @types/node line, and inference works across
			// all of them.
			socket.onclose = (event): void => finish(event.code, event.reason);

			socket.onmessage = (event): void => {
				let payload: Payload;
				try {
					payload = JSON.parse(String(event.data)) as Payload;
				} catch {
					log.warn("Discarded a malformed gateway frame.");
					return;
				}

				if (payload.s !== null && this.session) {
					this.session.sequence = payload.s;
				}

				switch (payload.op) {
					case Opcode.Hello: {
						const { heartbeat_interval: interval } = payload.d as HelloData;

						// Discord requires the first beat be offset by a random fraction of the
						// interval so that reconnecting clients do not arrive in lockstep.
						heartbeatTimer = setTimeout(() => {
							beat();
							heartbeatTimer = setInterval(beat, interval);
						}, interval * Math.random());

						if (resuming && this.session) {
							send(Opcode.Resume, {
								token: this.config.token,
								session_id: this.session.id,
								seq: this.session.sequence
							});
						} else {
							send(Opcode.Identify, {
								token: this.config.token,
								properties: { os: "Linux", browser: "Chrome", device: "" },
								presence: this.presence(),
								compress: false
							});
						}
						break;
					}

					case Opcode.HeartbeatAck:
						acknowledged = true;
						break;

					// The gateway can ask for a beat outside the schedule; answering late looks
					// the same to it as not answering at all.
					case Opcode.Heartbeat:
						acknowledged = false;
						send(Opcode.Heartbeat, this.session?.sequence ?? null);
						break;

					case Opcode.Reconnect:
						log.info("Gateway asked us to reconnect.");
						socket.close(CLOSE_ZOMBIE, "server requested reconnect");
						break;

					case Opcode.InvalidSession:
						// d is true only when the session survives; anything else means the resume
						// was rejected and the next attempt has to IDENTIFY from scratch.
						if (payload.d !== true) {
							this.session = null;
						}
						log.warn("Session invalidated by the gateway.");
						socket.close(CLOSE_ZOMBIE, "invalid session");
						break;

					case Opcode.Dispatch:
						if (payload.t === "READY") {
							const data = payload.d as ReadyData;
							this.session = {
								id: data.session_id,
								resumeUrl: data.resume_gateway_url
									? `${data.resume_gateway_url}/?v=9&encoding=json`
									: ENTRY_URL,
								sequence: payload.s
							};
							this.failures = 0;
							log.info(`Online as ${data.user.username} (${data.user.id}) [${this.config.status}].`);

							// READY carries every guild the account is in, so it arrives as tens of
							// megabytes of JSON and parsing it leaves an object graph that size behind.
							// Everything except the few fields above is garbage immediately -- but this
							// client allocates nothing afterwards, so V8 never faces the pressure that
							// would trigger a collection and simply keeps it resident for the life of
							// the process. The unit passes --expose-gc so we can hand it back once,
							// here, instead. RESUME does not re-send READY, so this runs rarely.
							//
							// It has to be deferred: inside this handler both the parsed payload and
							// the raw 28 MB frame are still live on the stack, so collecting here
							// reclaims nothing. setImmediate runs it once that frame has unwound.
							setImmediate(() => (globalThis as { gc?: () => void }).gc?.());
						} else if (payload.t === "RESUMED") {
							this.failures = 0;
							log.info("Session resumed.");
						}
						break;
				}
			};
		});
	}

	/**
	 * An activity with an empty state still registers as a custom status and shows up as a
	 * blank line under the name, so an unset CUSTOM_STATUS_TEXT has to mean no activity at
	 * all rather than an empty one.
	 */
	private presence(): Presence {
		return {
			status: this.config.status,
			since: 0,
			activities: this.config.customStatusText
				? [{ type: 4, name: "Custom Status", state: this.config.customStatusText }]
				: [],
			afk: false
		};
	}
}
