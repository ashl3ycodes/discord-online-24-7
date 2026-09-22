require("dotenv").config();
const fetch = require("node-fetch");
const WebSocket = require("ws");

if(!process.env.DISCORD_OAUTH_TOKEN) {
	process.exit(1);
}

const config = {
	status: process.env.STATUS || "online"
};

// Your account's custom status, mirrored from USER_SETTINGS_UPDATE. Kept across reconnects.
let customStatus = null;
const emojis = new Map();

function activities() {
	const cs = customStatus;
	if(!cs || (cs.expires_at && Date.parse(cs.expires_at) <= Date.now())) {
		return [];
	}
	const activity = {type: 4, name: "Custom Status", state: cs.text || null};
	if(cs.emoji_id) {
		const emoji = emojis.get(cs.emoji_id);
		const name = emoji?.name ?? cs.emoji_name;
		if(name) {
			activity.emoji = {id: cs.emoji_id, name, animated: !!emoji?.animated};
		}
	} else if(cs.emoji_name) {
		activity.emoji = {name: cs.emoji_name};
	}
	return activity.state || activity.emoji ? [activity] : [];
}

const headers = {
	Authorization: process.env.DISCORD_OAUTH_TOKEN,
	"Content-Type": "application/json",
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
};

async function validateToken() {
	try {
		const response = await fetch("https://discord.com/api/v9/users/@me", {headers});
		if(!response.ok) {
			throw new Error();
		}
		return await response.json();
	} catch {
		process.exit(1);
	}
}

function createWebSocketConnection(token) {
	return new Promise((resolve) => {
		const ws = new WebSocket("wss://gateway.discord.gg/?v=9&encoding=json");
		let heartbeatInterval;
		let expiryTimer;
		let seq = null;

		// Discord doesn't send an event when a custom status expires (your client clears it), so time it here.
		const sendPresence = () => {
			clearTimeout(expiryTimer);
			ws.send(JSON.stringify({op: 3, d: {status: config.status, since: 0, activities: activities(), afk: false}}));
			const msLeft = customStatus?.expires_at ? Date.parse(customStatus.expires_at) - Date.now() : 0;
			if(msLeft > 0) {
				expiryTimer = setTimeout(sendPresence, Math.min(msLeft + 1000, 2147483647));
			}
		};

		ws.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if(message.s) {
				seq = message.s;
			}

			if(message.t === "READY") {
				console.log(`Logged as ${message.d.user.username} (${message.d.user.id})`);
				if(message.d.user_settings) {
					customStatus = message.d.user_settings.custom_status ?? null;
				} else {
					console.warn("READY has no user_settings: Discord removed legacy settings, custom status sync won't work.");
				}
				message.d.guilds?.forEach(guild => guild.emojis?.forEach(emoji => emojis.set(emoji.id, emoji)));
				sendPresence();
			}

			// Servers joined, or emojis added, after READY.
			if(message.t === "GUILD_CREATE" || message.t === "GUILD_EMOJIS_UPDATE") {
				message.d.emojis?.forEach(emoji => emojis.set(emoji.id, emoji));
				if(message.d.emojis?.some(emoji => emoji.id === customStatus?.emoji_id)) {
					sendPresence();
				}
			}

			if(message.t === "USER_SETTINGS_UPDATE" && "custom_status" in message.d) {
				customStatus = message.d.custom_status;
				sendPresence();
			}

			switch(message.op) {
				case 10:
					heartbeatInterval = setInterval(() => {
						ws.send(JSON.stringify({op: 1, d: seq}));
					}, message.d.heartbeat_interval);

					ws.send(JSON.stringify({
						op: 2,
						d: {
							token: token,
							properties: {$os: "linux", $browser: "chrome", $device: "chrome"},
							presence: {
								status: config.status,
								since: 0,
								activities: activities(),
								afk: false
							}
						}
					}));
					break;
			}
		};

		// Without this, ws throws on a network error instead of letting the loop below reconnect.
		ws.onerror = () => {};

		ws.onclose = () => {
			clearInterval(heartbeatInterval);
			clearTimeout(expiryTimer);
			resolve();
		};
	});
}

async function main() {
	try {
		await validateToken();
		while(true) {
			try {
				await createWebSocketConnection(process.env.DISCORD_OAUTH_TOKEN);
				await new Promise(resolve => setTimeout(resolve, 5000));
			} catch {
				await new Promise(resolve => setTimeout(resolve, 10000));
			}
		}
	} catch {
		process.exit(1);
	}
}

main();