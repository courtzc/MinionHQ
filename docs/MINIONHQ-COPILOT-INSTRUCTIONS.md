# Global instructions for the GitHub Copilot CLI

## MinionHQ — the user's multi-session Copilot dashboard

The user runs a local web app called **MinionHQ** (in `~/repositories/MinionHQ`)
that manages multiple parallel Copilot CLI sessions, each on its own git
worktree and branch. The MinionHQ HTTP API runs at **http://127.0.0.1:4242**.

### When to spawn a MinionHQ session

When the user expresses intent like one of these — in any phrasing — they
want a new MinionHQ session, not for you to do the work yourself:

- "make me a new branch in <repo> for <thing>"
- "spawn a session in <repo> to <thing>"
- "fire up a MinionHQ tab for <thing> in <repo>"
- "new copilot for <thing> in <repo>"
- "kick off a session in <repo> off <branch> to <thing>"

Don't ask follow-up questions if you can confidently extract the three
fields. Otherwise ask once, briefly.

### How to spawn one

1. Resolve the user's intent into three fields:
   - **repo**: the short repo name (e.g. `fde-intake-automation`, `CAIRA`,
     `MinionHQ`). MinionHQ will resolve names against `~/repositories`. If
     unsure, list candidates by running `ls ~/repositories`.
   - **branch**: a short, informative branch name with a conventional
     prefix (`feat/`, `fix/`, `chore/`, `docs/`, `test/`, `refactor/`,
     `perf/`, `wip/`). Kebab-case, ≤50 chars, descriptive. Examples:
     - "data viz in fde intake" → `feat/data-viz`
     - "fix the chime throttle" → `fix/chime-throttle`
     - "update deps" → `chore/update-deps`
   - **base** *(optional)*: base branch to fork off. If the user said
     "off main" or "based on dev", honor it. Otherwise omit (MinionHQ uses the
     repo's current branch).
   - **prompt** *(optional)*: the actual task to inject as the first
     message to Copilot inside the new session. This is the meat of the
     request, paraphrased into a directive.

2. Call MinionHQ with one bash command:

   ```bash
   curl -sS -X POST http://127.0.0.1:4242/api/intent/create-session \
     -H 'Content-Type: application/json' \
     -d '{"repo":"<repo>","branch":"<branch>","base":"<base or omit>","prompt":"<prompt or omit>"}'
   ```

3. Report back to the user with the branch name and the worktree path
   from the response JSON. Tell them the new tab is open in MinionHQ at
   http://127.0.0.1:4242 (no need to copy/paste the openInBrowser URL —
   the tab auto-appears).

### Sanity checks

- If `curl` returns `{"ok":false,"error":"repo not found: ..."}`, list
  the candidates from the error message and ask which one.
- If MinionHQ is not running (connection refused), tell the user to start it:
  `cd ~/repositories/MinionHQ && npm start`.
- Don't ever try to start the worktree yourself — MinionHQ owns all worktrees
  and branch creation. Just call the endpoint.

### Example end-to-end

User: "make me a new branch in fde intake automation for us to do some
data viz"

You:
```bash
curl -sS -X POST http://127.0.0.1:4242/api/intent/create-session \
  -H 'Content-Type: application/json' \
  -d '{"repo":"fde-intake-automation","branch":"feat/data-viz","prompt":"Add a data visualization layer to the intake automation. Explore what would be most useful, then propose a plan before implementing."}'
```

Response:
```json
{"ok":true,"id":"...","branch":"feat/data-viz","worktreePath":"/Users/court/.minionhq/wt/.../",...}
```

Reply: "Spawned `feat/data-viz` in fde-intake-automation. Worktree at
`~/.minionhq/wt/<id>/`. The tab should be open in MinionHQ now."
