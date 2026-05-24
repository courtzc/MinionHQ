// Smoke test: open WS, spawn a session against /tmp/cm-test-repo with branch
// off main → verify (1) session.created arrives, (2) we receive binary PTY
// data frames, (3) the worktree + AGENTS.md + repo-context symlink exist.

import WebSocket from 'ws';
import { existsSync, readFileSync, readlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_REPO = '/tmp/cm-test-repo';

const ws = new WebSocket('ws://127.0.0.1:4242/ws');
let sessionId: string | null = null;
let binaryBytes = 0;
let jsonMsgs = 0;
let exitedCode: number | null | undefined = undefined;

ws.binaryType = 'arraybuffer';

ws.on('open', () => {
  console.log('[smoke] WS open');
  ws.send(JSON.stringify({
    t: 'session.new',
    repoPath: TEST_REPO,
    cwd: TEST_REPO,
    baseBranch: 'main',
    branchName: 'copilot/smoke-test',
    cmd: ['/bin/bash', '-c', 'echo "hello from session"; sleep 0.3; echo done; exit 0'],
  }));
});

ws.on('message', (raw, isBinary) => {
  if (isBinary) {
    const buf = raw as Buffer;
    const len = (buf as any).byteLength ?? (buf as any).length ?? 0;
    binaryBytes += Math.max(0, len - 17);
    return;
  }
  jsonMsgs++;
  const msg = JSON.parse(raw.toString('utf8'));
  if (msg.t === 'session.created') {
    sessionId = msg.session.id;
    console.log('[smoke] session.created:', {
      id: sessionId,
      branch: msg.session.branch,
      worktreePath: msg.session.worktreePath,
      repoPath: msg.session.repoPath,
    });
  } else if (msg.t === 'pty.exit') {
    exitedCode = msg.code;
    console.log('[smoke] pty.exit:', { code: msg.code, signal: msg.signal });
  } else if (msg.t === 'session.status') {
    console.log('[smoke] session.status:', msg.status);
  } else if (msg.t === 'error') {
    console.error('[smoke] error:', msg.message);
  }
});

ws.on('close', () => {
  console.log('[smoke] WS close');
  finish();
});

setTimeout(() => {
  ws.close();
}, 4000);

function finish() {
  console.log('[smoke] binary bytes received:', binaryBytes);
  console.log('[smoke] json msgs received:', jsonMsgs);
  console.log('[smoke] exit code:', exitedCode);

  // Verify on-disk artifacts (worktree should have been removed-or-preserved
  // depending on whether work was committed; we didn't make changes so worktree
  // still exists after exit since saveWorktreeWork only commits if dirty —
  // actually we keep the worktree dir on exit per the "never auto-delete" rule).
  console.log('\n[smoke] on-disk checks:');
  const wtRoot = '/Users/court/.minionhq/wt';
  if (!existsSync(wtRoot)) { console.log('  - no wt dir'); return; }
  const sessions = readdirSync(wtRoot);
  console.log('  - worktree dirs:', sessions);
  if (sessions.length === 0) { console.log('  ! no worktrees on disk'); return; }
  const sid = sessions[0];
  const wtPath = join(wtRoot, sid);
  const agents = join(wtPath, 'AGENTS.md');
  const ctxRoot = join(wtPath, '.minionhq');
  const link = join(ctxRoot, 'repo-context');

  console.log('  - AGENTS.md exists:', existsSync(agents));
  if (existsSync(agents)) {
    const head = readFileSync(agents, 'utf8').split('\n').slice(0, 6).join('\n');
    console.log('    head:', head);
  }
  console.log('  - .minionhq/ exists:', existsSync(ctxRoot));
  console.log('  - .minionhq/.gitignore exists:', existsSync(join(ctxRoot, '.gitignore')));
  console.log('  - .minionhq/notes/ exists:', existsSync(join(ctxRoot, 'notes')));
  if (existsSync(link)) {
    const lst = lstatSync(link);
    console.log('  - repo-context is symlink:', lst.isSymbolicLink());
    if (lst.isSymbolicLink()) {
      console.log('    → target:', readlinkSync(link));
      // Verify central context is reachable via the symlink
      const arch = join(link, 'architecture.md');
      console.log('  - architecture.md reachable via symlink:', existsSync(arch));
    }
  } else {
    console.log('  ! repo-context symlink missing');
  }
}
