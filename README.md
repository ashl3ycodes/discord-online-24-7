
## ⚠️ ⦁ Disclaimer
This software interacts with the Discord platform in a way that constitutes automation of a user account, which violates 
<a href="https://discord.com/terms">Discord's Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a>. Improper use may result in account suspension or permanent termination by Discord.
I'm not responsible for any penalties, losses, or damages resulting from the use of this code.
You are solely responsible for how you use this software. Proceed at your own discretion.

---

## ❔ ⦁ What do you need to use it?
- Node.js 22 or newer.
- Git.
- Any Javascript package manager.
- Your Discord Token.
> (IF YOU DON'T KNOW HOW TO GET IT, YOU SHOULDN'T BE USING THIS)

## ✅ ⦁ How to use it?
### Clone the repository and enter the folder.
```shell
git clone https://github.com/ashl3ycodes/Discord-Online-24-7
```

### Install the dependencies from `package.json` using any JavaScript package manager (for example, yarn):
```shell
yarn install
```
> All but one are build-time only. `ws` is a runtime dependency and has to travel with the build: it is what keeps the gateway handshake off Node's global `WebSocket`. `deploy.sh` ships `node_modules/ws`, which has no dependencies of its own.

### Rename the `.env.example` file to `.env` and fill in the variables:
`DISCORD_OAUTH_TOKEN`:  Your Discord token  
`STATUS`:  Can be one of the following: online, idle, dnd, invisible  

### Your custom status
Nothing to configure. Whatever custom status you set in your own Discord client — text,
emoji and "Clear after" — is mirrored here, so it stays up after you close Discord.
Change it or clear it on any device and this follows along.

### Build it and run it:
```shell
yarn build
yarn start
```

## 🚀 ⦁ Running it on a server
`deploy/deploy.sh` builds locally, rsyncs the result to a host, and installs a systemd
user service. It reads the host from `DEPLOY_HOST` (default `vps`) and the target folder
from `DEPLOY_DIR` (default `discord-online`):

```shell
yarn deploy
```

It never copies your local `.env` — the token stays wherever you put it on the server.
Once it's running:

```shell
systemctl --user status discord-online     # is it up
journalctl --user -u discord-online -f     # follow the log
systemctl --user restart discord-online    # after editing .env
```

Make sure lingering is on, or the service dies when your SSH session ends:
```shell
loginctl enable-linger "$USER"
```

## 🔧 ⦁ What changed in the TypeScript rewrite
Behaviour is the same; the reliability around it isn't. The notable fixes:

- **Zombie connections are detected.** Heartbeat acknowledgements are now tracked. A
  gateway connection whose TCP socket stays open after the far end stops listening — a
  dropped NAT mapping does exactly this — used to leave the old script sitting there
  believing it was still online, indefinitely. It now notices and rebuilds.
- **Sessions resume instead of re-identifying.** Reconnects send `RESUME` and only fall
  back to a full `IDENTIFY` when Discord refuses. Repeated identifies are rate limited
  and are one of the patterns that gets accounts flagged.
- **Socket errors no longer crash it.** There was no `error` handler, so a connection
  reset while connecting killed the process outright.
- **A boot before the network is up no longer kills it.** The old token check exited on
  *any* failure, including a transient DNS blip; only an actual rejection is fatal now.
- **Reconnects back off exponentially with jitter** rather than retrying on a flat 5s.
- **`RECONNECT` and `INVALID_SESSION` are handled** — both were previously ignored.
- **The custom status is mirrored from the account** instead of read from a fixed
  `CUSTOM_STATUS_TEXT`. Discord never publishes the status stored in your settings by
  itself — every connected client puts it in its own presence — so closing Discord used
  to leave this session online with nothing under the name. It now follows `READY` and
  `USER_SETTINGS_UPDATE`, emoji included, and runs the expiry timer that your client
  would have run had it been open.
- **Failures say why.** Every exit path used to be a bare `process.exit(1)`.
- **One runtime dependency, on purpose.** `dotenv` and `node-fetch` are gone, replaced by
  `process.loadEnvFile` and by deleting the startup token probe outright. `ws` stays. The
  v2.0.0 release swapped it for Node's global `WebSocket`, which is undici: that puts
  thirteen headers on every gateway upgrade including a literal `user-agent: node`, and
  offers ALPN in the TLS ClientHello, where `ws` sends six headers, no User-Agent and no
  ALPN. The account this ran on was disabled thirteen hours after that swap went live,
  having run forty days on `ws` without incident. `yarn test` fails if the dependency is
  dropped again.
- **`.gitignore` added** so `.env` can't be committed by accident.
