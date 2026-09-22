#!/usr/bin/env bash
# Builds locally and ships the result to the VPS. The build stays on this machine so the
# server never needs TypeScript, or a node_modules directory at all -- the compiled
# output has no runtime dependencies.
set -euo pipefail

HOST="${DEPLOY_HOST:-vps}"
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
