// node test.js — runs index.js against a fake gateway; never touches Discord.
const assert = require("assert");
const Module = require("module");

let gw;
const sent = [];
class FakeWebSocket {
	constructor() {
		gw = this;
		setImmediate(() => this.recv({op: 10, d: {heartbeat_interval: 1e9}}));
	}
	recv(message) { this.onmessage({data: JSON.stringify(message)}); }
	send(data) { sent.push(JSON.parse(data)); }
}
const load = Module._load;
Module._load = function(request, ...rest) {
	if(request === "ws") return FakeWebSocket;
	if(request === "node-fetch") return async () => ({ok: true, json: async () => ({})});
	if(request === "dotenv") return {config() {}};
	return load.call(this, request, ...rest);
};
process.env.DISCORD_OAUTH_TOKEN = "fake";
require("./index.js");

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const lastActivities = () => sent.at(-1).d.activities;

(async () => {
	await tick(50);
	assert.deepStrictEqual(sent[0].d.presence.activities, [], "identify with nothing known sends no empty custom status");

	gw.recv({op: 0, s: 1, t: "READY", d: {
		user: {username: "me", id: "1"},
		user_settings: {custom_status: {text: "hola", emoji_id: "42", emoji_name: null, expires_at: null}},
		guilds: [{emojis: [{id: "42", name: "wave", animated: true}]}]
	}});
	assert.deepStrictEqual(lastActivities(), [{type: 4, name: "Custom Status", state: "hola", emoji: {id: "42", name: "wave", animated: true}}]);

	gw.recv({op: 0, s: 2, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: null, emoji_id: null, emoji_name: "🔥", expires_at: null}}});
	assert.deepStrictEqual(lastActivities(), [{type: 4, name: "Custom Status", state: null, emoji: {name: "🔥"}}]);

	gw.recv({op: 0, s: 2, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: null, emoji_id: "77", emoji_name: null, expires_at: null}}});
	assert.deepStrictEqual(lastActivities(), [], "an emoji-only status with an unknown emoji isn't sent empty");
	gw.recv({op: 0, s: 2, t: "GUILD_EMOJIS_UPDATE", d: {guild_id: "5", emojis: [{id: "77", name: "new", animated: false}]}});
	assert.deepStrictEqual(lastActivities(), [{type: 4, name: "Custom Status", state: null, emoji: {id: "77", name: "new", animated: false}}], "emoji added after READY shows up");

	const before = sent.length;
	gw.recv({op: 0, s: 3, t: "USER_SETTINGS_UPDATE", d: {theme: "dark"}});
	assert.strictEqual(sent.length, before, "unrelated settings changes don't resend presence");

	gw.recv({op: 0, s: 4, t: "USER_SETTINGS_UPDATE", d: {custom_status: null}});
	assert.deepStrictEqual(lastActivities(), [], "clearing it on the client clears it here");

	gw.recv({op: 0, s: 5, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: "x", emoji_id: null, emoji_name: null, expires_at: null}}});
	gw.recv({op: 0, s: 6, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: null, emoji_id: null, emoji_name: null, expires_at: null}}});
	assert.deepStrictEqual(lastActivities(), [], "an all-null status counts as cleared");

	gw.recv({op: 0, s: 7, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: "brb", expires_at: new Date(Date.now() + 200).toISOString()}}});
	assert.strictEqual(lastActivities()[0].state, "brb");
	const beforeExpiry = sent.length;
	await tick(1500);
	assert.strictEqual(sent.length, beforeExpiry + 1, "expiry sends exactly one update, no loop");
	assert.deepStrictEqual(lastActivities(), [], "expired status is removed");

	gw.recv({op: 0, s: 8, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: "old", expires_at: new Date(Date.now() - 1000).toISOString()}}});
	assert.deepStrictEqual(lastActivities(), [], "an already-expired status is never shown");

	gw.recv({op: 0, s: 9, t: "USER_SETTINGS_UPDATE", d: {custom_status: {text: "keep"}}});
	gw.onclose();
	await tick(5100);
	assert.strictEqual(sent.at(-1).op, 2, "reconnects with a fresh identify");
	assert.strictEqual(sent.at(-1).d.presence.activities[0].state, "keep", "reconnect keeps the last known status");
	gw.recv({op: 0, s: 1, t: "READY", d: {user: {username: "me", id: "1"}, user_settings: {custom_status: null}}});
	assert.deepStrictEqual(lastActivities(), [], "a status cleared while disconnected is cleared on READY");

	console.log("ok");
	process.exit(0);
})().catch(error => {
	console.error(error);
	process.exit(1);
});
