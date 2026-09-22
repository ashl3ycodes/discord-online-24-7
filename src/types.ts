/** The subset of the Discord gateway protocol a presence-only client has to speak. */

export enum Opcode {
	Dispatch = 0,
	Heartbeat = 1,
	Identify = 2,
	PresenceUpdate = 3,
	Resume = 6,
	Reconnect = 7,
	InvalidSession = 9,
	Hello = 10,
	HeartbeatAck = 11
}

export type Status = "online" | "idle" | "dnd" | "invisible";

export interface Payload {
	op: Opcode;
	d: unknown;
	s: number | null;
	t: string | null;
}

export interface HelloData {
	heartbeat_interval: number;
}

export interface ReadyData {
	session_id: string;
	/** Absent on older gateway builds, so treat it as optional and fall back to the entry URL. */
	resume_gateway_url?: string;
	user: {
		id: string;
		username: string;
	};
	/**
	 * The legacy JSON settings, which is where the account's custom status lives. Discord
	 * marks them deprecated in favour of a protobuf blob and omits them for clients that
	 * ask for the USER_SETTINGS_PROTO capability, which this one deliberately does not.
	 */
	user_settings?: UserSettings;
	guilds?: EmojiHolder[];
}

export interface UserSettings {
	custom_status?: CustomStatus | null;
}

/** Nullable throughout: a status can be text only, emoji only, or cleared field by field. */
export interface CustomStatus {
	text?: string | null;
	emoji_id?: string | null;
	emoji_name?: string | null;
	/** ISO 8601, unlike the protobuf form which counts milliseconds. */
	expires_at?: string | null;
}

/** READY guilds, GUILD_CREATE and GUILD_EMOJIS_UPDATE all carry emojis in this shape. */
export interface EmojiHolder {
	emojis?: GuildEmoji[];
}

export interface GuildEmoji {
	id: string;
	name: string;
	animated?: boolean;
}

export interface ActivityEmoji {
	/** Absent for a unicode emoji, which is carried by name alone. */
	id?: string;
	name: string;
	animated?: boolean;
}

export interface Activity {
	type: 4;
	name: "Custom Status";
	state: string | null;
	emoji?: ActivityEmoji;
}

export interface Presence {
	status: Status;
	since: number;
	activities: Activity[];
	afk: boolean;
}
