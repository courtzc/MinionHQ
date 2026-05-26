import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { WORKTREE_DIR, DEFAULTS, ensureDirs } from './paths.js';

/**
 * Produce a friendly, stable directory slug for a repository — the same scheme
 * used by `repoKey()` in context.ts so worktrees and central context line up
 * on disk: `<lowercase-slug>-<10char-sha1>`. Two repos with the same basename
 * (e.g. multiple `notes/` checkouts) get distinct hashes; the same repo across
 * sessions always lands in the same dir.
 */
function repoSlugKey(realPath: string): string {
  const hash = createHash('sha1').update(realPath).digest('hex').slice(0, 10);
  const slug = basename(realPath).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return `${slug || 'repo'}-${hash}`;
}

/** Filesystem-safe slug for a branch name. `feat/foo` → `feat--foo`. */
function branchSlug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '--').replace(/^-+|-+$/g, '') || 'branch';
}

export interface WorktreeInfo {
  repoPath: string;
  worktreePath: string;
  branch: string;
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
}

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  try { return run(cmd, args, cwd); } catch { return null; }
}

export function isGitRepo(p: string): boolean {
  if (!existsSync(p)) return false;
  return tryRun('git', ['rev-parse', '--git-dir'], p) != null;
}

export function repoToplevel(p: string): string {
  const top = run('git', ['rev-parse', '--show-toplevel'], p);
  return resolve(top);
}

export function listBranches(repoPath: string): string[] {
  const out = tryRun('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoPath);
  return out ? out.split('\n').filter(Boolean) : [];
}

export function currentBranch(repoPath: string): string | null {
  return tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
}

export interface DiscoveredRepo {
  name: string;
  path: string;
  defaultBranch: string | null;
}

const DEFAULT_REPOS_BASE = DEFAULTS.reposBase;

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export function discoverRepos(base?: string): { base: string; repos: DiscoveredRepo[] } {
  const baseAbs = resolve(expandHome(base?.trim() || DEFAULT_REPOS_BASE));
  if (!existsSync(baseAbs)) return { base: baseAbs, repos: [] };

  let entries: string[];
  try {
    entries = readdirSync(baseAbs);
  } catch {
    return { base: baseAbs, repos: [] };
  }

  const repos: DiscoveredRepo[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(baseAbs, name);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    // Quick check: does it contain .git?
    if (!existsSync(join(full, '.git'))) continue;
    repos.push({
      name,
      path: full,
      defaultBranch: currentBranch(full),
    });
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { base: baseAbs, repos };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

function uniqueBranch(repoPath: string, base: string): string {
  const existing = new Set(listBranches(repoPath));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`;
    if (!existing.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

function looksLikeGitWorktree(p: string): boolean {
  // A worktree contains a .git file (pointer) or .git dir. If either exists,
  // there is potentially uncommitted work here and we must NOT clobber it.
  try {
    const gp = join(p, '.git');
    return existsSync(gp);
  } catch {
    return false;
  }
}

function hasUncommittedChanges(worktreePath: string): boolean {
  // --porcelain returns empty stdout when the working tree is clean (incl. untracked).
  const out = tryRun('git', ['status', '--porcelain', '--untracked-files=normal'], worktreePath);
  return out != null && out.length > 0;
}

function hasUpstream(worktreePath: string): boolean {
  return tryRun('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], worktreePath) != null;
}

function hasRemote(worktreePath: string): boolean {
  const out = tryRun('git', ['remote'], worktreePath);
  return out != null && out.length > 0;
}

export interface CreateOpts {
  sessionId: string;
  repoPath: string;
  branchName?: string;
  baseBranch?: string;
}

export function createWorktree(opts: CreateOpts): WorktreeInfo {
  ensureDirs();
  const repoPath = repoToplevel(opts.repoPath);

  const desired = opts.branchName?.trim() || `feat/${slug(opts.sessionId.slice(0, 8))}`;
  const branch = uniqueBranch(repoPath, desired);
  // Friendly worktree path: `<WORKTREE_DIR>/<repo-slug>/<branch-slug>`.
  // Two checkouts of the same repo at the same branch get a `-<id>` suffix
  // to stay unique without resorting to a bare UUID.
  let canonicalRepo: string;
  try { canonicalRepo = realpathSync(repoPath); } catch { canonicalRepo = repoPath; }
  const repoDir = repoSlugKey(canonicalRepo);
  let bSlug = branchSlug(branch);
  let worktreePath = join(WORKTREE_DIR, repoDir, bSlug);
  if (existsSync(worktreePath)) {
    bSlug = `${bSlug}--${opts.sessionId.slice(0, 8)}`;
    worktreePath = join(WORKTREE_DIR, repoDir, bSlug);
  }

  // SAFETY: never overwrite an existing worktree. If something is at the target
  // path with a .git inside, abort — the user might have uncommitted work.
  if (existsSync(worktreePath)) {
    if (looksLikeGitWorktree(worktreePath)) {
      throw new Error(
        `worktree path already exists and contains .git — refusing to overwrite: ${worktreePath}`
      );
    }
    // Empty dir from a previous failed init — only remove if truly empty.
    try {
      const stat = lstatSync(worktreePath);
      if (stat.isDirectory()) {
        // Don't recursively rm; require empty directory.
        // If non-empty, abort.
        const entries = require('node:fs').readdirSync(worktreePath);
        if (entries.length > 0) {
          throw new Error(
            `worktree path already exists and is non-empty — refusing to overwrite: ${worktreePath}`
          );
        }
        require('node:fs').rmdirSync(worktreePath);
      } else {
        throw new Error(`worktree path exists and is not a directory: ${worktreePath}`);
      }
    } catch (e) {
      if (e && (e as Error).message.includes('refusing to overwrite')) throw e;
      throw e;
    }
  }
  mkdirSync(join(WORKTREE_DIR, repoDir), { recursive: true });

  const base = opts.baseBranch?.trim() || currentBranch(repoPath) || 'HEAD';

  // git worktree add -b <branch> <path> <base>
  run('git', ['worktree', 'add', '-b', branch, worktreePath, base], repoPath);

  return { repoPath, worktreePath, branch };
}

export interface SaveResult {
  committed: boolean;
  pushed: boolean;
  commitSha?: string;
  message?: string;
  error?: string;
}

/**
 * Auto-commit any uncommitted work in the worktree to its branch and
 * (best-effort) push to remote. This is called on session exit so that
 * NOTHING the agent did is ever silently lost.
 *
 * Never throws — returns a SaveResult describing what happened. The worktree
 * directory itself is NOT removed by this function; the user must explicitly
 * archive a session for that.
 */
export function saveWorktreeWork(worktreePath: string, sessionId: string): SaveResult {
  if (!existsSync(worktreePath)) {
    return { committed: false, pushed: false, error: 'worktree path missing' };
  }
  if (!hasUncommittedChanges(worktreePath)) {
    return { committed: false, pushed: false };
  }
  try {
    // Configure a friendly committer identity for this commit only, in case
    // the user has none globally. (Falls through to git defaults if set.)
    const hasUser = tryRun('git', ['config', 'user.email'], worktreePath);
    const userArgs: string[] = [];
    if (!hasUser) {
      userArgs.push(
        '-c', 'user.email=minionhq@local',
        '-c', 'user.name=MinionHQ',
      );
    }

    run('git', ['add', '-A'], worktreePath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const msg = `[minionhq] WIP ${ts} (session ${sessionId.slice(0, 8)})`;
    // Use --no-verify to skip pre-commit hooks — this is a safety net commit.
    run('git', [...userArgs, 'commit', '--no-verify', '-m', msg], worktreePath);
    const sha = tryRun('git', ['rev-parse', 'HEAD'], worktreePath) ?? undefined;

    let pushed = false;
    if (hasRemote(worktreePath)) {
      // If no upstream yet, set it to origin/<same-branch>.
      const upstreamSet = hasUpstream(worktreePath);
      const pushArgs = upstreamSet
        ? ['push']
        : ['push', '--set-upstream', 'origin', 'HEAD'];
      const out = tryRun('git', pushArgs, worktreePath);
      pushed = out != null;
    }
    return { committed: true, pushed, commitSha: sha, message: msg };
  } catch (e) {
    return {
      committed: false,
      pushed: false,
      error: (e as Error).message.slice(0, 500),
    };
  }
}

/**
 * Explicit archive — caller-driven. Saves any pending work first, then
 * removes the worktree directory (NOT the branch — that always persists).
 * Returns the SaveResult of the safety commit so the caller can surface it.
 */
export function archiveWorktree(repoPath: string, worktreePath: string, sessionId: string): SaveResult {
  const save = saveWorktreeWork(worktreePath, sessionId);
  // Even if commit/push failed, do NOT remove the worktree — surface the error.
  if (save.error) return save;
  if (existsSync(worktreePath)) {
    tryRun('git', ['worktree', 'remove', worktreePath], repoPath);
    // Don't force, don't recursive-rm. If git refused, the user has work to inspect.
  }
  tryRun('git', ['worktree', 'prune'], repoPath);
  return save;
}

export function pruneAll(repoPaths: string[]): void {
  for (const r of repoPaths) tryRun('git', ['worktree', 'prune'], r);
}

