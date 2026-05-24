import { parseIntent } from '../src/web/nlParse.js';

const repos = [
  { name: 'CAIRA', path: '/x', defaultBranch: 'main' },
  { name: 'copilot-multi', path: '/x', defaultBranch: 'main' },
  { name: 'fde-intake-automation', path: '/x', defaultBranch: 'main' },
  { name: 'fde-program', path: '/x', defaultBranch: 'master' },
  { name: 'meeting-intel', path: '/x', defaultBranch: 'master' },
  { name: 'to-do', path: '/x', defaultBranch: 'main' },
];

const phrases = [
  'make me a new branch in fde intake automation for us to do some data viz',
  'add data viz to fde intake automation',
  'fix the chime throttle in copilot-multi',
  'refactor the auth flow in CAIRA off main',
  'update deps in to-do',
  'write tests for fde-program',
  'document the API in copilot-multi',
  'experiment with whisper in meeting-intel',
  'speed up the parser in copilot-multi',
  'chore/rename in fde-program based on dev',
  'fix a nasty bug in the websocket reconnect logic in copilot-multi',
  'investigate why MCP servers are slow to start in fde-program',
  'add support for dark mode in to-do',
  'random gibberish',
];

for (const p of phrases) {
  const r = parseIntent(p, repos);
  const repo = r.repo?.name ?? '—';
  const base = r.baseBranch ? ` ← ${r.baseBranch}` : '';
  const conf = r.confidence === 'high' ? '' : ` [${r.confidence}]`;
  console.log(`${p}\n  → ${repo} / ${r.branchName}${base}${conf}\n`);
}
