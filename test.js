/**
 * Twenty checks over the one failure this project has actually had.
 *
 * On 2026-09-22 the v2.0.0 rewrite dropped `ws` for Node's global WebSocket and deleted the
 * browser User-Agent from a REST token probe. Undici puts thirteen headers on every gateway
 * upgrade -- `user-agent: node` among them -- and offers ALPN in the TLS ClientHello, so both
 * the header set and the JA3/JA4 changed, on the persistent connection, on every reconnect.
 * The account was disabled thirteen hours later, having run forty days on `ws` untouched.
 *
 * The first draft of this file measured `ws` and undici directly and passed even with the
 * client's ws import deleted: it was characterising the libraries, not the program. So the
 * measured checks now drive the real compiled client against a fake gateway and read what it
 * actually sends. Each check is labelled measured, control or structural, because that
 * distinction is exactly what failed last time -- the regression was invisible to everything
 * that did not look at the wire.
 *
 * Run with `yarn test`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import WsWebSocket, { WebSocketServer } from "ws";
import { startFakeGateway } from "./fake-gateway.js";

let passed = 0;
const check = (n, what, how, fn) => {
	try {
		fn();
	} catch (error) {
		console.error(`\n  ✗ ${n}. ${what}  [${how}]\n    ${error.message}\n`);
		process.exitCode = 1;
		return;
	}
	passed++;
	console.log(`  ✓ ${n.toString().padStart(2)}. ${what}  [${how}]`);
};

/** tsc keeps comments, and this file's own prose names what it forbids. */
const code = (path) =>
	readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const gateway = code("dist/gateway.js");
const index = code("dist/index.js");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const KNOWN_GOOD = ["connection", "host", "sec-websocket-extensions", "sec-websocket-key", "sec-websocket-version", "upgrade"];
const UNDICI_TELL = ["accept", "accept-encoding", "accept-language", "cache-control", "pragma", "sec-fetch-mode"];

// ---------------------------------------------------------------------------
// Drive the real compiled client against a fake gateway and record what it sends.
// ---------------------------------------------------------------------------

const fake = await startFakeGateway({
	// Drop the first session once it is established, with a code Discord treats as
	// resumable, so the client's reconnect path is exercised rather than described.
	onIdentified: (socket, n) => {
		if (n === 1) {
			setTimeout(() => socket.close(4000, "test drop"), 400).unref();
		}
	}
});

/**
 * The entry URL is a hardcoded constant in src/gateway.ts and stays that way: an override
 * read from the environment would be a knob that redirects a live Discord token to an
 * arbitrary host if it were ever set wrong in production. Rewriting the constant in a load
 * hook keeps that inside this process, where the token is fake, and still lets every
 * assertion above observe the real client instead of a re-implementation of it.
 */
registerHooks({
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (!url.endsWith("/dist/gateway.js")) return result;
		return { ...result, source: result.source.toString().replace("wss://gateway.discord.gg", fake.url) };
	}
});

const { PresenceClient } = await import("./dist/gateway.js");
const client = new PresenceClient({ token: "fake-token-for-the-local-server", status: "idle" });
client.run().catch(() => {});

// Enough for: connect, IDENTIFY, READY, heartbeats, a forced drop, RESUME, RESUMED.
await new Promise((resolve) => setTimeout(resolve, 2_500));
client.stop();
fake.stop();

const sent = fake.seen.frames;
const identify = sent.find((f) => f.op === 2);
const heartbeats = sent.filter((f) => f.op === 1);
const resume = sent.find((f) => f.op === 6);
const presences = sent.filter((f) => f.op === 3);

console.log(`\n  client upgrade: ${Object.keys(fake.seen.headers ?? {}).sort().join(", ")}`);
console.log(`  client sent:    ${sent.map((f) => `op${f.op}`).join(" ")}  across ${fake.seen.connections} connections\n`);

check(1, "the client's own upgrade carries no User-Agent", "measured", () => {
	assert.ok(fake.seen.headers, "the client never connected");
	assert.equal(fake.seen.headers["user-agent"], undefined,
		`client sent user-agent: ${fake.seen.headers["user-agent"]}`);
});

check(2, "the client's upgrade is exactly the six headers of the 40-day build", "measured", () =>
	assert.deepEqual(Object.keys(fake.seen.headers).sort(), KNOWN_GOOD));

check(3, "the client IDENTIFYs with its token and browser properties", "measured", () => {
	assert.ok(identify, "no IDENTIFY was sent");
	assert.equal(identify.d.token, "fake-token-for-the-local-server");
	assert.equal(identify.d.properties.browser, "Chrome");
});

check(4, "the heartbeat carries the sequence, not the old null", "measured", () => {
	assert.ok(heartbeats.length > 0, "no heartbeat was sent");
	assert.ok(heartbeats.some((h) => h.d !== null),
		`every heartbeat sent d: null — ${JSON.stringify(heartbeats.map((h) => h.d))}`);
});

check(5, "a resumable drop produces a RESUME, not a second IDENTIFY", "measured", () => {
	assert.ok(fake.seen.connections > 1, "the client never reconnected");
	assert.ok(resume, `reconnected without resuming — sent ${sent.map((f) => `op${f.op}`).join(" ")}`);
	assert.equal(resume.d.session_id, "fake-session");
	assert.equal(sent.filter((f) => f.op === 2).length, 1, "spent a second IDENTIFY on a resumable drop");
});

check(6, "the account's custom status from READY is published", "measured", () => {
	const published = presences.find((f) => f.d.activities?.length) ?? identify;
	assert.equal(published.d.presence?.status ?? published.d.status, "idle");
	const activity = (published.d.presence?.activities ?? published.d.activities ?? [])[0];
	assert.ok(activity || presences.length, "no presence carrying the custom status was sent");
});

// ---------------------------------------------------------------------------
// Controls: the same measurements against undici, so checks 1-2 can actually fail.
// ---------------------------------------------------------------------------

function handshake(Ctor) {
	return new Promise((resolve, reject) => {
		const server = createServer();
		const wss = new WebSocketServer({ server });
		wss.on("connection", (socket, req) => { socket.close(); server.close(); resolve(req.headers); });
		server.listen(0, () => {
			const c = new Ctor(`ws://127.0.0.1:${server.address().port}/?v=9&encoding=json`);
			c.onerror = () => {};
		});
		setTimeout(() => reject(new Error("handshake timed out")), 5_000).unref();
	});
}

/**
 * ALPNCallback fires while the ClientHello is parsed -- the only point both clients reach,
 * since the self-signed certificate means neither completes the handshake. It fires only when
 * the client sent an ALPN extension, so "the socket connected but the callback never ran" is
 * what distinguishes ws from undici. This one is library-level: the client speaks ws:// to the
 * local gateway, so checks 13 and 14 are what tie this result to the client.
 */
function alpn(Ctor) {
	return new Promise((resolve, reject) => {
		const dir = join(tmpdir(), "discord-online-test-tls");
		const key = join(dir, "key.pem");
		const cert = join(dir, "cert.pem");
		if (!existsSync(cert)) {
			mkdirSync(dir, { recursive: true });
			execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
				"-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
		}
		let offered = null;
		const server = createTlsServer({
			key: readFileSync(key),
			cert: readFileSync(cert),
			ALPNCallback: ({ protocols }) => { offered = protocols; return undefined; }
		});
		server.on("tlsClientError", () => {});
		server.on("connection", () => setTimeout(() => { server.close(); resolve(offered); }, 500).unref());
		server.listen(0, () => {
			const c = new Ctor(`wss://127.0.0.1:${server.address().port}/`);
			c.onerror = () => {};
		});
		setTimeout(() => reject(new Error("TLS probe timed out")), 10_000).unref();
	});
}

const viaGlobal = await handshake(globalThis.WebSocket);
const alpnWs = await alpn(WsWebSocket);
const alpnGlobal = await alpn(globalThis.WebSocket);

console.log(`  ws ALPN:     ${JSON.stringify(alpnWs)}`);
console.log(`  undici ALPN: ${JSON.stringify(alpnGlobal)}`);
console.log(`  undici upgrade: ${Object.keys(viaGlobal).sort().join(", ")}\n`);

check(7, "undici would send user-agent: node — check 1 can fail", "control", () =>
	assert.equal(viaGlobal["user-agent"], "node"));

check(8, "undici would send six extra headers — check 2 can fail", "control", () =>
	UNDICI_TELL.forEach((h) => assert.ok(viaGlobal[h] !== undefined, `undici lacks ${h}`)));

check(9, "ws offers no ALPN where undici does, so the TLS fingerprints differ", "control", () => {
	assert.equal(alpnWs, null, `ws offered ALPN: ${JSON.stringify(alpnWs)}`);
	assert.ok(Array.isArray(alpnGlobal) && alpnGlobal.length > 0, "undici offered no ALPN");
});

// ---------------------------------------------------------------------------
// Measured: how the compiled program behaves when systemd starts it.
// ---------------------------------------------------------------------------

const run = (env) => spawnSync(process.execPath, ["dist/index.js"], {
	env: { PATH: process.env.PATH, HOME: "/nonexistent", ...env },
	encoding: "utf8",
	timeout: 15_000
});

const noToken = run({ DISCORD_OAUTH_TOKEN: "" });
const badStatus = run({ DISCORD_OAUTH_TOKEN: "x", STATUS: "lurking" });

check(10, "a missing token exits 78, which systemd refuses to restart", "measured", () => {
	assert.equal(noToken.status, 78, `exited ${noToken.status}: ${noToken.stderr}`);
	assert.match(noToken.stderr, /DISCORD_OAUTH_TOKEN/);
});

check(11, "an invalid STATUS exits 78 rather than connecting", "measured", () => {
	assert.equal(badStatus.status, 78, `exited ${badStatus.status}: ${badStatus.stderr}`);
	assert.match(badStatus.stderr, /STATUS must be one of/);
});

check(12, "startup opens zero sockets before the config is valid", "measured", () => {
	const strace = spawnSync("strace", ["-f", "-e", "trace=connect", "-qq", process.execPath, "dist/index.js"], {
		env: { PATH: process.env.PATH, HOME: "/nonexistent", DISCORD_OAUTH_TOKEN: "" },
		encoding: "utf8",
		timeout: 15_000
	});
	// No silent pass: an unrun check is not evidence.
	if (strace.error) throw new Error(`strace unavailable (${strace.error.code}); ran no syscall check`);
	const inet = strace.stderr.split("\n").filter((l) => /connect\(.*sin_(addr|port)/.test(l));
	assert.equal(inet.length, 0, `opened ${inet.length} network connections:\n${inet.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Structural: invariants over the compiled output and the packaging.
// ---------------------------------------------------------------------------

check(13, "dist/gateway.js imports ws", "structural", () =>
	assert.match(gateway, /^import WebSocket from "ws";$/m));

check(14, "no compiled file reaches for the global WebSocket", "structural", () => {
	for (const file of ["dist/gateway.js", "dist/index.js", "dist/config.js", "dist/log.js"]) {
		const body = code(file);
		if (/\bnew WebSocket\(/.test(body)) {
			assert.match(body, /^import WebSocket from "ws";$/m, `${file} constructs WebSocket without importing ws`);
		}
	}
});

check(15, "the REST token probe is gone", "structural", () =>
	assert.doesNotMatch(index, /users\/@me|\bfetch\(/));

check(16, "no compiled file carries any other HTTP client", "structural", () =>
	[gateway, index, code("dist/config.js")].forEach((body) =>
		assert.doesNotMatch(body, /node-fetch|undici|require\(['"]https?['"]\)|from ['"]node:https?['"]/)));

check(17, "op 7 Reconnect and op 9 InvalidSession are both handled", "structural", () => {
	assert.match(gateway, /case Opcode\.Reconnect:/);
	assert.match(gateway, /case Opcode\.InvalidSession:/);
});

check(18, "the first heartbeat is jittered across the interval", "structural", () =>
	assert.match(gateway, /interval \* Math\.random\(\)/));

check(19, "4004 is fatal and never retried", "structural", () =>
	assert.match(gateway, /CLOSE_AUTH_FAILED[\s\S]{0,200}?throw new FatalGatewayError/));

check(20, "ws is a runtime dependency, ships to the VPS, and 78 stays unrestartable", "structural", () => {
	assert.ok(pkg.dependencies?.ws, "ws is not in dependencies");
	assert.ok(!pkg.devDependencies?.ws, "ws is in devDependencies, so it would not ship");
	assert.match(readFileSync("deploy/deploy.sh", "utf8"), /--relative node_modules\/ws/);
	assert.match(readFileSync("deploy/discord-online.service", "utf8"), /^RestartPreventExitStatus=78$/m);
});

console.log(`\n  ${passed}/20 checks passed\n`);
if (process.exitCode) console.error("  FAILED — do not deploy\n");
