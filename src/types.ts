/** The subset of the Discord gateway protocol a presence-only client has to speak. */

export enum Opcode {
	Dispatch = 0,
	Heartbeat = 1,
	Identify = 2,
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
}

export interface Activity {
	type: 4;
	name: "Custom Status";
	state: string;
}

export interface Presence {
	status: Status;
	since: number;
	activities: Activity[];
	afk: boolean;
}
