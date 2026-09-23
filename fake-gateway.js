/**
 * The smallest server that can make the real client complete a session: HELLO, then READY
 * for an IDENTIFY and RESUMED for a RESUME, acknowledging heartbeats throughout. It records
 * the upgrade headers and every frame the client sends, which is what turns "the code
 * imports ws" into "the client put these bytes on the wire".
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export function startFakeGateway({ onIdentified } = {}) {
	const seen = { headers: null, frames: [], connections: 0 };
	const server = createServer();
	const wss = new WebSocketServer({ server });

	wss.on("connection", (socket, req) => {
		seen.headers ??= req.headers;
		seen.connections++;
		const mine = seen.connections;

		socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 120 }, s: null, t: null }));

		socket.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			seen.frames.push(frame);

			if (frame.op === 2) {
				socket.send(JSON.stringify({
					op: 0, s: 7, t: "READY",
					d: {
						session_id: "fake-session",
						resume_gateway_url: `ws://127.0.0.1:${server.address().port}`,
						user: { id: "119818892976586752", username: "ashl3ycodes" },
						user_settings: { custom_status: { text: "testing", emoji_name: "🔧" } },
						guilds: []
					}
				}));
				onIdentified?.(socket, mine);
			} else if (frame.op === 6) {
				socket.send(JSON.stringify({ op: 0, s: 8, t: "RESUMED", d: {} }));
			} else if (frame.op === 1) {
				socket.send(JSON.stringify({ op: 11, d: null, s: null, t: null }));
			}
		});
	});

	return new Promise((resolve) => {
		server.listen(0, () => resolve({
			url: `ws://127.0.0.1:${server.address().port}`,
			seen,
			stop: () => { wss.close(); server.close(); }
		}));
	});
}
