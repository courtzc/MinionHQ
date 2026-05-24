// Heuristic natural-language parser for new-session intent.
//
// Given a phrase like "make me a new branch in fde intake automation
// for us to do some data viz" and a list of known repos, returns
// `{ repoPath, branchName, baseBranch?, matched }`.
//
// Strategy:
// 1. Normalize the phrase (lowercase, strip punctuation).
// 2. For each repo, score how well its name (or any token form of it)
//    appears in the phrase. Best score wins.
// 3. Strip the matched repo phrase + common chatter words from the
//    remainder, then slugify what's left into a short branch name.
// 4. Return null repo if no repo scored above threshold — caller can
//    fall back to manual entry.

export interface RepoCandidate {
  name: string;
  path: string;
  defaultBranch: string | null;
}

export interface ParsedIntent {
  repo: RepoCandidate | null;
  branchName: string;          // always prefixed copilot/
  baseBranch: string | null;   // null = use repo default
  matchedRepoSubstr: string;   // what got matched against the phrase
  intentText: string;          // remaining text after stripping repo + chatter
  confidence: 'high' | 'medium' | 'low';
}

const CHATTER = new Set<string>([
  'a','an','the','please','pls','can','you','make','me','i','want','need','wanted',
  'new','branch','create','start','spawn','open','fire','let','lets','let\'s','for','us',
  'to','some','do','of','in','on','at','with','and','&','session','sesh',
  'tab','off','from','about','around','that','will','would','should',
  'this','it','one','please.','please,','then','also','now','today',
]);

// Conventional-commit / common prefix detection from verbs and keywords.
// First matching pattern wins. We keep the matched word in the slug so the
// branch name reads naturally — "fix/fix-chime-throttle" is fine.
const PREFIX_PATTERNS: Array<{ prefix: string; re: RegExp }> = [
  { prefix: 'fix',      re: /\b(fix(?:es|ed|ing)?|bug|broken|hotfix|repair(?:s|ed|ing)?|patch(?:es|ed|ing)?|debug(?:ging)?)\b/i },
  { prefix: 'docs',     re: /\b(doc|docs|document(?:s|ed|ing|ation)?|readme|comment(?:s|ed|ing)?)\b/i },
  { prefix: 'test',     re: /\b(test(?:s|ed|ing)?|spec|specs|coverage)\b/i },
  { prefix: 'refactor', re: /\b(refactor(?:s|ed|ing)?|cleanup|clean[\s-]?up|tidy|simplify|reorgani[sz]e|restructure)\b/i },
  { prefix: 'perf',     re: /\b(perf|performance|optimi[sz]e[sd]?|optimi[sz]ing|speed[\s-]?up|faster|latency)\b/i },
  { prefix: 'chore',    re: /\b(bump|update[sd]?|updating|upgrade[sd]?|upgrading|dep|deps|dependency|dependencies|chore|configure[sd]?|configuring|rename[sd]?|renaming)\b/i },
  { prefix: 'feat',     re: /\b(feat|feature|add(?:s|ed|ing)?|implement(?:s|ed|ing)?|introduce[sd]?|introducing|support|enable[sd]?|enabling|build(?:s|ing)?)\b/i },
  { prefix: 'wip',      re: /\b(explore[sd]?|exploring|experiment(?:s|ed|ing)?|prototype[sd]?|spike|investigate[sd]?|investigating|research(?:ing)?)\b/i },
];

const BASE_HINTS: Array<{ re: RegExp; group: number }> = [
  // "off main", "off of main", "from main", "based on main"
  { re: /\boff(?:\s+of)?\s+([a-z0-9._/-]+)\b/i, group: 1 },
  { re: /\bfrom\s+([a-z0-9._/-]+)\b/i, group: 1 },
  { re: /\bbased\s+on\s+([a-z0-9._/-]+)\b/i, group: 1 },
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s\-_./]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

// Score how much of a repo's name appears, in order, in the phrase.
// Returns { score: 0..1, matchedSubstr }.
function scoreRepoMatch(phrase: string, repoName: string): { score: number; matched: string } {
  const phraseTokens = tokenize(phrase);
  // Split repo name on common separators and on camelCase.
  const repoTokens = repoName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_./\s]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
  if (repoTokens.length === 0) return { score: 0, matched: '' };

  // Direct full-name substring (handles "fde-intake-automation" appearing literally).
  const flat = phraseTokens.join(' ');
  const repoFlat = repoTokens.join(' ');
  if (flat.includes(repoFlat)) {
    return { score: 1, matched: repoFlat };
  }
  // Dashed form.
  if (flat.includes(repoTokens.join('-'))) {
    return { score: 1, matched: repoTokens.join('-') };
  }

  // Token-by-token in-order match.
  let i = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let p = 0; p < phraseTokens.length && i < repoTokens.length; p++) {
    if (phraseTokens[p] === repoTokens[i]) {
      if (firstIdx < 0) firstIdx = p;
      lastIdx = p;
      i++;
    }
  }
  const matchedCount = i;
  const score = matchedCount / repoTokens.length;
  if (matchedCount === 0) return { score: 0, matched: '' };
  const matched = phraseTokens.slice(firstIdx, lastIdx + 1).join(' ');
  // Penalize if there's huge gap between first and last matched token (probably coincidence).
  const span = lastIdx - firstIdx + 1;
  const density = matchedCount / span;
  return { score: score * density, matched };
}

function slugifyIntent(text: string): string {
  const tokens = tokenize(text).filter((t) => !CHATTER.has(t));
  // Keep up to ~6 meaningful tokens for an informative branch name.
  const kept = tokens.slice(0, 6);
  const joined = kept.join('-').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return joined.slice(0, 50);
}

function detectPrefix(text: string): { prefix: string; matched: string } {
  for (const p of PREFIX_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { prefix: p.prefix, matched: m[0] };
  }
  return { prefix: 'feat', matched: '' };
}

// If the user explicitly typed a prefix in the phrase (e.g. "chore/" or
// "feat:"), honor it AND strip it.
function explicitPrefix(text: string): { prefix: string; matched: string } | null {
  const m = text.match(/\b(feat|feature|fix|chore|docs|test|refactor|perf|wip|build|ci|style|revert)[/:]\s*/i);
  if (!m) return null;
  const p = m[1].toLowerCase();
  return { prefix: p === 'feature' ? 'feat' : p, matched: m[0] };
}

export function parseIntent(phrase: string, repos: RepoCandidate[]): ParsedIntent {
  const raw = phrase.trim();
  if (!raw) {
    return {
      repo: null, branchName: 'feat/session', baseBranch: null,
      matchedRepoSubstr: '', intentText: '', confidence: 'low',
    };
  }

  // 1. Find best repo match.
  let best: { repo: RepoCandidate; score: number; matched: string } | null = null;
  for (const r of repos) {
    const { score, matched } = scoreRepoMatch(raw, r.name);
    if (!best || score > best.score) best = { repo: r, score, matched };
  }
  const repo = best && best.score >= 0.5 ? best.repo : null;
  const matchedSubstr = best?.matched ?? '';

  // 2. Look for an explicit base-branch hint.
  let baseBranch: string | null = null;
  for (const hint of BASE_HINTS) {
    const m = raw.match(hint.re);
    if (m) { baseBranch = m[hint.group]; break; }
  }

  // 3. Strip the repo match + base hint + prefix-trigger from the phrase
  //    to derive the intent text → slug.
  let remainder = raw;
  if (matchedSubstr) {
    const re = new RegExp(matchedSubstr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    remainder = remainder.replace(re, ' ');
  }
  for (const hint of BASE_HINTS) {
    remainder = remainder.replace(hint.re, ' ');
  }

  // 4. Pick a prefix — explicit overrides heuristic.
  //    Explicit prefixes like "chore/rename" get stripped from the slug
  //    (otherwise we'd duplicate the literal "chore/" in the branch name).
  //    Heuristic verbs are left in place — "fix/fix-chime-throttle" reads
  //    more naturally than "fix/chime-throttle" for a one-glance branch name.
  const explicit = explicitPrefix(raw);
  const detected = explicit ?? detectPrefix(raw);
  const prefix = detected.prefix;
  if (explicit && explicit.matched) {
    const re = new RegExp(explicit.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    remainder = remainder.replace(re, ' ');
  }

  // 5. Slugify. Fall back to the matched verb if everything got stripped.
  const slug = slugifyIntent(remainder) || slugifyIntent(detected.matched) || 'session';
  const branchName = `${prefix}/${slug}`;

  // 6. Confidence.
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (best && best.score >= 0.85 && slug !== 'session') confidence = 'high';
  else if (best && best.score >= 0.5) confidence = 'medium';

  return {
    repo,
    branchName,
    baseBranch,
    matchedRepoSubstr: matchedSubstr,
    intentText: remainder.trim(),
    confidence,
  };
}
