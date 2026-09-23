/**
 * node test-status.js -- drives the built client against a fake socket, so the custom status
 * mirroring can be checked without a token, an account, or a network.
 *
 * The fake used to be installed by assigning globalThis.WebSocket, which worked only because
 * the client took its socket from that global -- the same undici global whose handshake got
 * the account disabled. The client imports ws now, so the stub goes in through a module hook
 * instead. Convenient testing was the quiet reason to depend on the global in the first
 * place; this keeps the convenience without putting undici back on the wire.
 *
 * test.js is the companion to this file: it covers what the client puts on the wire, this one
 * covers what it does with what it receives.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "ws" ? { url: "stub:ws", shortCircuit: true } : next(specifier, context),
	load: (url, context, next) =>
		url === "stub:ws"
			? { format: "module", shortCircuit: true, source: "export default globalThis.__FAKE_WS__;" }
			: next(url, context)
});

const sent = [];
let socket;

class FakeWebSocket {
	static OPEN = 1;
	readyState = 1;

	constructor() {
		socket = this;
		queueMicrotask(() => this.receive({ op: 10, d: { heartbeat_interval: 600_000 } }));
	}

	receive(payload) {
		this.onmessage({ data: JSON.stringify({ s: null, t: null, ...payload }) });
	}

	send(data) {
		sent.push(JSON.parse(data));
	}

	close(code = 1006, reason = "test") {
		this.onclose({ code, reason });
	}
}

globalThis.__FAKE_WS__ = FakeWebSocket;

const { PresenceClient } = await import("./dist/gateway.js");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const lastFrame = (op) => sent.findLast((frame) => frame.op === op);
const activities = () => lastFrame(3).d.activities;

const READY = {
	op: 0,
	s: 1,
	t: "READY",
	d: {
		session_id: "abc",
		user: { id: "1", username: "me" },
		user_settings: { custom_status: { text: "hola", emoji_id: "42", emoji_name: null, expires_at: null } },
		guilds: [{ emojis: [{ id: "42", name: "wave", animated: true }] }]
	}
};

const client = new PresenceClient({ token: "fake", status: "online" });
const running = client.run();
await tick();

assert.deepEqual(lastFrame(2).d.presence.activities, [], "identify with nothing known yet carries no activity");

socket.receive(READY);
assert.deepEqual(activities(), [
	{ type: 4, name: "Custom Status", state: "hola", emoji: { id: "42", name: "wave", animated: true } }
], "the status set on another client is published here, animated emoji and all");

socket.receive({ op: 0, s: 2, t: "USER_SETTINGS_UPDATE", d: { custom_status: { emoji_name: "🔥" } } });
assert.deepEqual(activities(), [
	{ type: 4, name: "Custom Status", state: null, emoji: { name: "🔥" } }
], "an emoji-only status keeps its emoji and no text");

const unrelated = sent.length;
socket.receive({ op: 0, s: 3, t: "USER_SETTINGS_UPDATE", d: { theme: "dark" } });
assert.equal(sent.length, unrelated, "a settings change that is not the custom status publishes nothing");

socket.receive({ op: 0, s: 4, t: "USER_SETTINGS_UPDATE", d: { custom_status: null } });
assert.deepEqual(activities(), [], "clearing it on the other client clears it here");

socket.receive({ op: 0, s: 5, t: "USER_SETTINGS_UPDATE", d: { custom_status: { emoji_id: "77" } } });
assert.deepEqual(activities(), [], "an emoji from a guild we have never seen is not published nameless");
socket.receive({ op: 0, s: 6, t: "GUILD_EMOJIS_UPDATE", d: { guild_id: "5", emojis: [{ id: "77", name: "new" }] } });
assert.deepEqual(activities(), [
	{ type: 4, name: "Custom Status", state: null, emoji: { id: "77", name: "new", animated: false } }
], "and is published as soon as the guild carrying it arrives");

const quiet = sent.length;
socket.receive({ op: 0, s: 6, t: "GUILD_EMOJIS_UPDATE", d: { guild_id: "9", emojis: [{ id: "99", name: "elsewhere" }] } });
socket.receive({ op: 0, s: 6, t: "GUILD_EMOJIS_UPDATE", d: { guild_id: "5", emojis: [{ id: "77", name: "new" }, { id: "78", name: "extra" }] } });
assert.equal(sent.length, quiet, "emoji churn that leaves the published status alone publishes nothing");

socket.receive({ op: 0, s: 7, t: "USER_SETTINGS_UPDATE", d: { custom_status: { text: "brb", expires_at: new Date(Date.now() + 200).toISOString() } } });
assert.equal(activities()[0].state, "brb");
const beforeExpiry = sent.length;
await tick(1_500);
assert.equal(sent.length, beforeExpiry + 1, "an expiry publishes exactly once, with no timer loop behind it");
assert.deepEqual(activities(), [], "and the expired status is gone");

socket.receive({ op: 0, s: 8, t: "USER_SETTINGS_UPDATE", d: { custom_status: { text: "old", expires_at: new Date(Date.now() - 1_000).toISOString() } } });
assert.deepEqual(activities(), [], "a status that expired while we were away is never published");

socket.receive({ op: 0, s: 9, t: "USER_SETTINGS_UPDATE", d: { custom_status: { text: "keep", expires_at: new Date(Date.now() + 60_000).toISOString() } } });
socket.close();
await tick(1_500);
assert.equal(lastFrame(6).d.session_id, "abc", "a drop resumes the session instead of identifying again");
const beforeResume = sent.length;
socket.receive({ op: 0, s: 10, t: "RESUMED", d: {} });
assert.ok(sent.length > beforeResume, "the resumed connection publishes the status itself");
assert.equal(activities()[0].state, "keep", "the status survives the reconnect, expiry timer and all");

client.stop();
await running;
assert.equal(
	process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length,
	0,
	"stopping leaves no timer behind to hold the process open"
);
console.log("  ok - custom status mirroring, expiry and resume behave");
