#!/usr/bin/env bash
# Builds locally and ships the result to the VPS. The build stays on this machine so the
# server never needs TypeScript. It does need one runtime dependency: ws, which is what
# keeps the gateway handshake off Node's global WebSocket (see src/gateway.ts). ws has no
# dependencies of its own, so that is the only directory that has to travel.
set -euo pipefail

HOST="${DEPLOY_HOST:-xyra}"
REMOTE_DIR="${DEPLOY_DIR:-discord-online}"
UNIT="discord-online.service"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "==> Building"
yarn build

echo "==> Syncing to $HOST:~/$REMOTE_DIR"
# .env is deliberately absent from this list: the token lives only on the server, and
# copying the local one over would overwrite it with whatever happens to be here.
rsync -az --delete \
	--exclude ".git" \
	--exclude "node_modules" \
	--exclude ".env" \
	dist src deploy package.json tsconfig.json .env.example README.md \
	"$HOST:$REMOTE_DIR/"

# Separate because --relative is global to an invocation, and it is what puts ws at
# node_modules/ws on the far side instead of flattening it to the project root.
rsync -az --delete --relative node_modules/ws "$HOST:$REMOTE_DIR/"

echo "==> Installing the unit"
ssh "$HOST" "
	set -e
	mkdir -p ~/.config/systemd/user
	install -m 644 ~/$REMOTE_DIR/deploy/$UNIT ~/.config/systemd/user/$UNIT
	systemctl --user daemon-reload
	systemctl --user enable $UNIT
	if [ -s ~/$REMOTE_DIR/.env ]; then
		systemctl --user restart $UNIT
		echo '==> Restarted'
	else
		echo '==> ~/$REMOTE_DIR/.env is missing or empty; not starting.'
	fi
"

echo "==> Done"
