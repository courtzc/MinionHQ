# MinionHQ

Run multiple GitHub Copilot CLI sessions side-by-side in your browser. Each session lives on its own git branch in its own worktree, with shared per-repo context and durable history.

```
┌─ tabs ──────────────────────────────────────────────────────────────┐
│ • feat/data-viz  • fix/chime-throttle  • docs/specs  • + new  • ↻ │
├─────────────────────────────────────────────────────────────────────┤
│  (xterm.js terminal — full Copilot CLI, ANSI passthrough)           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Quickstart

You need **macOS or Linux**, **Node.js ≥ 20**, and **git ≥ 2.30**. On macOS, the easiest setup:

```bash
# 0. Prerequisites (skip any you already have)
brew install node git
brew install terminal-notifier   # optional — nicer toasts with click-to-focus

# 1. Install the GitHub Copilot CLI and sign in
npm install -g @github/copilot
copilot      # follow the device-login prompt the first time, then /exit

# 2. Clone MinionHQ
git clone https://github.com/<you>/MinionHQ ~/repositories/MinionHQ
cd ~/repositories/MinionHQ

# 3. Install + run
npm install   # postinstall rebuilds node-pty and builds the web bundle
npm start
```

Open <http://127.0.0.1:4242> in any modern browser. No special terminal emulator needed — the browser handles ANSI via xterm.js.

> **First session**: click **+ new**, pick a repo from the dropdown (defaults to `~/repositories/*`), name the branch (e.g. `feat/foo`), optionally type a starter prompt, and hit *Create*. A new tab appears with Copilot CLI running in a fresh worktree on that branch.

If anything goes wrong, jump to [Troubleshooting](#troubleshooting).

## Use

**New session** → click **+ new**, pick a repo from the dropdown, give the branch a name (`feat/foo`), optionally set a base branch. MinionHQ creates a git worktree at `~/.minionhq/wt/<id>/` on that branch and starts Copilot CLI inside it.

**Multiple sessions** → spawn as many as you want. Each one is fully isolated (own branch, own worktree, own Copilot process). Switch with the tab bar.

**Resume** → click **↻ resume**. Sessions are restored from disk on server restart. Closed Copilot processes are kept dormant and can be resumed in place via `copilot --resume`.

**Auto-commit on exit** → if you leave uncommitted work in a session's worktree when it exits, MinionHQ auto-commits it to the branch as `WIP <ts>`. Your work is never lost.

**Per-repo shared context** → drop notes in `~/.minionhq/repos/<repo-key>/context/*.md`. Every session for that repo (any branch) sees them via a symlink at `<worktree>/.minionhq/repo-context/` and an auto-generated `AGENTS.md` that tells Copilot where to look.

## Spawn from your regular Copilot CLI

Add this to your global `~/.copilot/copilot-instructions.md` (or copy the version in [`docs/MINIONHQ-COPILOT-INSTRUCTIONS.md`](docs/MINIONHQ-COPILOT-INSTRUCTIONS.md)). It teaches Copilot to recognize phrases like *"spawn a session in fde-intake for data viz"* and call:

```bash
curl -sS -X POST http://127.0.0.1:4242/api/intent/create-session \
  -H 'Content-Type: application/json' \
  -d '{"repo":"<repo>","branch":"feat/<thing>","prompt":"<task>"}'
```

A new tab opens in MinionHQ with the prompt pre-submitted.

## On disk

```
~/.minionhq/
├── db.sqlite              durable session metadata
├── logs/<id>/             pty.log + events.jsonl per session
├── attachments/<id>/      files dropped/pasted into a session
├── repos/<key>/
│   ├── meta.json          { realPath, slug, ... }
│   └── context/*.md       shared central context (you edit this)
└── wt/<id>/               git worktrees (one per session)
    └── .minionhq/
        ├── repo-context/  → symlink to ~/.minionhq/repos/<key>/context/
        ├── notes/         session-only scratch
        └── AGENTS.md      auto-generated for Copilot
```

The `.minionhq/` dir inside each worktree is git-ignored.

## HTTP API (loopback only)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness probe (`{ ok, protocolVersion }`) |
| `GET` | `/api/repos/discover?base=<dir>` | List git repos under `<dir>` (defaults to `MINIONHQ_REPOS_BASE`) |
| `GET` | `/api/repo/branches?path=<repo>` | List branches in a repo |
| `POST` | `/api/intent/create-session` | Spawn a session (`{repo, branch, base?, prompt?}`) — used by the NL-spawn integration |
| `GET` | `/api/sessions/dormant` | List resumable sessions |
| `GET/POST` | `/api/repo/context/{list,read,write,delete}` | Shared per-repo context files |
| `POST` | `/api/attachments?id=<sid>&name=<file>` | Stream-upload a file (image/text) into a session |
| `GET` | `/api/logs/tail?id=<sid>&stream=<pty\|events>` | Tail the last N bytes of a session's log |
| `GET` | `/api/alerts/catalog` | Read the alert/chime registry (drives the picker page) |
| `POST` | `/api/notify` | Server-side notification trigger (`{kind, title?, body?}`) |
| `GET` | `/api/notify/capabilities` | Probe native OS notification support (`{mac: bool}`) |
| `GET` | `/api/system-sounds` | List macOS system sounds for chime picker |

WebSocket at `/` for live PTY streams + status events. Binds to `127.0.0.1` only.

## Architecture

The server (Node + `node-pty`) spawns Copilot CLI in a pseudo-terminal per session and pipes ANSI bytes over WebSocket to xterm.js in the browser. Status (`spawning` / `idle` / `working` / `needs-input` / `error` / `exited`) is derived from the CLI's own `events.jsonl` sidecar — not regex-on-PTY-bytes — so badges and OS notifications stay accurate even when the agent renders fancy ANSI. SQLite stores enough metadata to resume any session after a restart.

End-to-end keystroke latency on localhost is ~5ms — imperceptible vs running Copilot directly in a terminal.

## Configuration

Optional env vars (all default to sensible values):

| Env var                | Default       | Purpose                                       |
| ---------------------- | ------------- | --------------------------------------------- |
| `MINIONHQ_HOST`        | `127.0.0.1`   | HTTP/WS listen host                           |
| `MINIONHQ_PORT`        | `4242`        | HTTP/WS listen port                           |
| `MINIONHQ_COPILOT_BIN` | `copilot`     | Path to the Copilot CLI binary                |
| `MINIONHQ_HOME`        | `~/.minionhq` | Data dir (db, logs, worktrees, repo context)  |
| `MINIONHQ_REPOS_BASE`  | `~/repositories` | Default base dir for repo discovery (overridable in the new-session modal) |

Repo discovery looks under `MINIONHQ_REPOS_BASE` (default `~/repositories`).

## Hacking

```
src/
├── shared/         types & registries used by BOTH server and browser
│   ├── protocol.ts   ServerMsg / ClientMsg / SessionStatus / SessionStats
│   ├── alerts.ts     ⭐ ONE source of truth for chime / notification kinds
│   └── binProtocol.ts pty binary-frame helpers
├── server/         Node-side: PTY spawning, SQLite, HTTP/WS, OS notifications
│   ├── index.ts      HTTP+WS server, all REST endpoints
│   ├── sessions.ts   per-session lifecycle, CLI event parsing, status derivation
│   ├── worktrees.ts  git worktree creation + repo discovery
│   ├── macNotify.ts  native macOS toasts (terminal-notifier / osascript)
│   ├── logs.ts       events.jsonl + pty.log tailing
│   ├── context.ts    shared per-repo central context
│   └── …
├── web/            Browser bundle (esbuilt to public/app.js)
│   ├── app.ts        SPA shell: tabs, terminal, footer, modals
│   ├── alertDispatcher.ts  coalesces status transitions → chime/notify
│   ├── chimes.ts     Web Audio decoded-buffer cache + playback
│   ├── notify.ts     browser / mac notification router
│   ├── repoColors.ts deterministic per-repo color hashing
│   └── chimes.html   standalone picker page (fetches /api/alerts/catalog)
└── test/           node --test suite (FakeClock harness, contract tests)
```

**Adding a new alert kind**: append one entry to `ALERTS` in `src/shared/alerts.ts`. TypeScript will fail every consumer (`Record<AlertKind, …>`) until you fill in the new entry. No other file needs to change — the picker, the dispatcher priority, the browser title, and the OS sound all flow from the registry.

**Scripts**:

```bash
npm start         # production server (no auto-restart)
npm run dev       # node --watch for hot reload
npm run typecheck # tsc --noEmit
npm test          # node --test test/*.test.ts (59 tests, ~300ms)
npm run build:web # esbuild → public/
```

## Troubleshooting

**`Error: cannot find module node-pty`** — the postinstall step that rebuilds `node-pty` against your Node binary didn't run, or you switched Node versions since. Re-run `npm install` (or just `node scripts/fix-node-pty.mjs`).

**`copilot: command not found` when spawning a session** — install the GitHub Copilot CLI with `npm install -g @github/copilot` and run `copilot` once to sign in. Or point MinionHQ at a custom location with `MINIONHQ_COPILOT_BIN=/abs/path/to/copilot`.

**No repos in the dropdown** — the default discovery base is `~/repositories`. Either move your checkouts there, set `MINIONHQ_REPOS_BASE=/other/path`, or click *change* in the new-session modal.

**No OS notifications on macOS** — install `terminal-notifier` (`brew install terminal-notifier`) for click-to-focus and the minion icon. The fallback `osascript` path always works but has no click handler.

**Chime is silent the first time** — browsers gate `AudioContext` on the first user gesture. Click anywhere in the dashboard once; the audio is pre-warmed thereafter.

**Port already in use** — `lsof -ti:4242 | xargs kill` and `npm start` again, or set `MINIONHQ_PORT=4343`.

## Status

Pre-1.0. Works for the author on macOS daily. Expect rough edges. Not packaged for distribution yet.

## License

[MIT](LICENSE)
