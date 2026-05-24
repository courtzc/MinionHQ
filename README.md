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

## Requirements

- macOS or Linux
- Node.js ≥ 20
- git ≥ 2.30
- The [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and signed in (`copilot` on `$PATH`)

## Install

```bash
git clone <this-repo> ~/repositories/MinionHQ
cd ~/repositories/MinionHQ
npm install
npm start
```

Open <http://127.0.0.1:4242>.

> `npm install` runs a `postinstall` script that rebuilds `node-pty` against your Node binary. If you change Node versions, re-run it.

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
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/repos/discover` | List repos under `~/repositories` |
| `GET` | `/api/repo/branches?path=<repo>` | List branches in a repo |
| `POST` | `/api/intent/create-session` | Spawn a session (`{repo, branch, base?, prompt?}`) |
| `GET` | `/api/sessions/dormant` | List resumable sessions |
| `GET/POST` | `/api/repo/context/*` | Read/write shared context files |

WebSocket at `/` for live PTY streams. Binds to `127.0.0.1` only.

## Architecture

The server (Node + `node-pty`) spawns Copilot CLI in a pseudo-terminal per session and pipes ANSI bytes over WebSocket to xterm.js in the browser. Status (`idle` / `thinking` / `needs-input` / `error`) is classified from the stream and broadcast for tab badges and OS notifications. SQLite stores enough metadata to resume any session after a restart.

End-to-end keystroke latency on localhost is ~5ms — imperceptible vs running Copilot directly in a terminal.

## Configuration

Currently zero config — paths and port are hardcoded (`127.0.0.1:4242`, `~/.minionhq/`). Discovery looks under `~/repositories`. PRs welcome to make these `env`-configurable.

## Status

Pre-1.0. Works for the author on macOS daily. Expect rough edges. Not packaged for distribution yet.

## License

MIT
