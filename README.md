# GTPS Controller Website

A small web panel for managing a Growtopia Private Server from the same machine that stores the server files. It is based on the practical controls found in GTPS Discord controller bots, but the panel and its backend are written for this project.

## What it can do

- Admin login configured in `config.json`.
- Show server process status, online count (`online.txt`), player file count and world file count.
- Start, stop and restart the configured server executable.
- Turn maintenance mode on or off by updating the `maint|` line in `server_data.php`.
- Find player JSON files and view gems, WL, XP, level and admin role level.
- Add to or set gems, WL, XP, level and admin role level.
- Create a backup before changing `server_data.php` or a player data file.
- Keep a small audit log of admin actions.

## Requirements

- Node.js 20 or newer.
- Run the panel on the GTPS host, or on a machine with access to the GTPS files and executable.
- The account running Node must have permission to read and write the configured files and to start/stop the server process.

## Setup

1. Put this project on the GTPS machine.
2. Copy `config.example.json` to `config.json`.
3. Generate a password hash:

   ```bash
   npm run hash-password -- "your-long-admin-password"
   ```

4. Paste the printed `scrypt$...` value into `admin.passwordHash` in `config.json`. Set `admin.username` to the login name you want.
5. Change `sessionSecret` to a long random string (at least 32 characters).
6. Edit the paths in `config.json` so they point to your GTPS files. Relative paths are resolved from this project directory. The default layout assumes the GTPS folders sit beside this project; adjust them if your panel is stored elsewhere.
7. Start the panel:

   ```bash
   npm start
   ```

8. Open `http://127.0.0.1:3000` from the GTPS host.

## Configuration notes

- `paths.serverExecutable`: executable to launch, for example `../GTPS/server.exe`.
- `paths.serverWorkingDirectory`: working directory used when launching the executable.
- `paths.players` / `paths.worlds`: GTPS player and world folders.
- `paths.gemDb`: optional folder containing per-player `.txt` gem balances. If a matching file exists, it is used for gem reads and updates.
- `paths.serverData`: the `server_data.php` file used by the Growtopia client. The panel changes the `maint|` line and saves the previous file under `paths.backups` first.
- `paths.onlineFile`: optional text file containing the current online count.
- `paths.serverLog`: optional text log file; reserved for the log viewer endpoint.
- `server.processName`: exact process name used to check whether a server started outside this panel.

Player files can be named either `GrowID.json` or `GrowID_.json`. The panel only exposes a short list of numeric fields and never returns the stored password or the complete player JSON to the browser.

## Network and security

The panel binds to `127.0.0.1` by default. Keep it local unless you know how to secure remote access. For remote access, put it behind a reverse proxy with HTTPS, set `secureCookies` to `true`, use a strong `sessionSecret`, and restrict access with a firewall or VPN. Do not expose the panel directly to the public internet.

The login uses a scrypt password hash, signed in-memory sessions, same-site HTTP-only cookies, a CSRF token for changes, and a small login rate limit. Restarting the panel signs everyone out. The session store is in memory, so this is intended for a single private admin panel rather than a multi-user hosted service.

## Tests

Run the built-in tests with:

```bash
npm test
```

The tests cover maintenance-file parsing, safe player IDs, path checks and numeric value changes. A live server start/stop test requires a real GTPS executable and is not included.

## Project layout

```text
GTPS-Controller-Website/
├── config.example.json
├── lib/gtps.js
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── scripts/hash-password.js
├── test/gtps.test.js
├── package.json
└── server.js
```
