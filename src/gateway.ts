import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.js";
import type { Config } from "./config.js";
import {
	Opcode,
	type Activity,
	type CustomStatus,
	type EmojiHolder,
	type GuildEmoji,
	type HelloData,
	type Payload,
	type Presence,
	type ReadyData,
	type UserSettings
} from "./types.js";

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

	/**
	 * The account's custom status, as Discord last reported it. Nobody else publishes it
	 * for us: the value in the settings is only how clients sync it to each other, and each
	 * one puts it in its own presence. That is why closing the desktop client used to take
	 * the custom status down with it, leaving this session online with nothing under the
	 * name. Held across reconnects so a RESUME, which never repeats READY, keeps it.
	 */
	private customStatus: CustomStatus | null = null;

	/**
	 * Names and animated flags for custom emoji, which a custom status refers to by id
	 * alone. A few hundred kilobytes against the tens of megabytes of READY that get freed
	 * right after, and the alternative is guessing at a name and rendering an animated
	 * emoji as a still image.
	 */
	private readonly emojis = new Map<string, GuildEmoji>();

	/** Discord sends no event when a custom status expires; see syncPresence(). */
	private expiry: NodeJS.Timeout | undefined;

	/** What was last published, so reconnects don't repeat a line that hasn't changed. */
	private published = "";

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
				clearTimeout(this.expiry);
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

			/**
			 * Publishes whatever the settings currently say, and arms a timer for a status
			 * that expires. The expiry has to be enforced here: the server keeps the timestamp
			 * but sends nothing when it passes -- it is the official client that notices and
			 * clears the setting, and the whole point of this process is to be the only thing
			 * connected once that client is gone.
			 */
			const syncPresence = (): void => {
				clearTimeout(this.expiry);
				const presence = this.presence();
				send(Opcode.PresenceUpdate, presence);

				const [activity] = presence.activities;
				const summary = activity ? `${activity.emoji?.name ?? ""} ${activity.state ?? ""}`.trim() : "none";
				if (summary !== this.published) {
					this.published = summary;
					log.info(`Custom status: ${summary}`);
				}

				const expiresAt = this.customStatus?.expires_at;
				const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : 0;
				if (remaining > 0) {
					// Capped because setTimeout takes a 32-bit delay and silently fires at once
					// past that; a clamped wake-up just re-arms itself.
					this.expiry = setTimeout(syncPresence, Math.min(remaining + 1_000, 2_147_483_647));
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

							if (data.user_settings) {
								this.customStatus = data.user_settings.custom_status ?? null;
							} else {
								log.warn("READY carried no user_settings; the custom status cannot be mirrored.");
							}
							data.guilds?.forEach((guild) => this.remember(guild));
							syncPresence();

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

							// Anything missed while the socket was down is replayed right after this,
							// so the only stale thing is an expiry that came and went in the meantime,
							// along with the timer that was cleared with the old connection.
							if (this.customStatus?.expires_at) {
								syncPresence();
							}
						} else if (payload.t === "USER_SETTINGS_UPDATE") {
							// A partial: only what changed is serialized, so an update about
							// something else entirely says nothing about the custom status.
							const settings = payload.d as UserSettings;
							if ("custom_status" in settings) {
								this.customStatus = settings.custom_status ?? null;
								syncPresence();
							}
						} else if (payload.t === "GUILD_CREATE" || payload.t === "GUILD_EMOJIS_UPDATE") {
							// A server joined after READY, or an emoji added to one. Without this the
							// status would keep an emoji it cannot name until the next reconnect.
							const guild = payload.d as EmojiHolder;
							if (this.remember(guild) && this.customStatus?.emoji_id) {
								syncPresence();
							}
						}
						break;
				}
			};
		});
	}

	/** Stores a guild's emoji, and reports whether any of them are new to us. */
	private remember(guild: EmojiHolder): boolean {
		return guild.emojis?.reduce((added, emoji) => {
			const known = this.emojis.get(emoji.id);
			this.emojis.set(emoji.id, emoji);
			return added || known?.name !== emoji.name || known.animated !== emoji.animated;
		}, false) ?? false;
	}

	/**
	 * An activity with an empty state still registers as a custom status and shows up as a
	 * blank line under the name, so a status with nothing left in it has to mean no activity
	 * at all rather than an empty one.
	 */
	private presence(): Presence {
		return {
			status: this.config.status,
			since: 0,
			activities: this.activities(),
			afk: false
		};
	}

	private activities(): Activity[] {
		const status = this.customStatus;
		if (!status || (status.expires_at && Date.parse(status.expires_at) <= Date.now())) {
			return [];
		}

		const activity: Activity = { type: 4, name: "Custom Status", state: status.text || null };

		if (status.emoji_id) {
			// The settings record a custom emoji by id and, depending on which client wrote
			// them, nothing else. A name is required in the activity, so an emoji from a guild
			// this session has never seen is dropped rather than sent nameless.
			const emoji = this.emojis.get(status.emoji_id);
			const name = emoji?.name ?? status.emoji_name;
			if (name) {
				activity.emoji = { id: status.emoji_id, name, animated: emoji?.animated ?? false };
			}
		} else if (status.emoji_name) {
			activity.emoji = { name: status.emoji_name };
		}

		return activity.state || activity.emoji ? [activity] : [];
	}
}
