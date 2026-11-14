#!/usr/bin/env node
// Called only after a successful nrw-update, including both data pushes.
// The issue's own reports are the durable state: no daily reminder, no new
// state file on a data branch, and a failed comment can be retried next run.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TABLES = ['pegel_messwerte.txt', 'nieder_messwerte.txt', 'temp_messwerte.txt'];
const DEGRADED = 'nrw-update run degraded:';
const RECOVERED = 'nrw-update fine series recovered:';

function normalize(names) {
  const missing = [...new Set(names.map(n => n.trim()).filter(Boolean))].sort();
  if (missing.some(n => !TABLES.includes(n))) throw new Error('unknown LANUK fine-series table');
  return missing;
}

// Recognizes the old unmarked warning too (issue #12). Other pipeline reports
// and human comments cannot acknowledge or reset this particular incident.
export function lastFineStatus(comments) {
  for (const c of [...comments].reverse()) {
    // gh issue list uses the GraphQL spelling; comments use the REST one.
    if (!['github-actions[bot]', 'app/github-actions'].includes(c.user?.login)) continue;
    const body = c.body || '';
    if (body.startsWith(RECOVERED)) return [];
    if (!body.startsWith(DEGRADED)) continue;
    const names = /^The LANUK export lacked ([\w., -]+) —/m.exec(body)?.[1];
    if (names) return normalize(names.split(','));
  }
  return [];
}

function runGh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
}

export function main(argv = process.argv.slice(2), { env = process.env, gh = runGh } = {}) {
  if (argv.length) throw new Error('usage: node scripts/report-nrw-fine-status.mjs (no arguments)');
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  }
  if (env.DEGRADED === undefined) throw new Error('DEGRADED must be set (empty for a complete run)');
  const missing = normalize(env.DEGRADED.split(','));
  const [issue] = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', 'data-freshness',
    '--state', 'open', '--limit', '1', '--json', 'number,body,author']));
  let previous = [];
  if (issue) {
    const pages = JSON.parse(gh(['api', '--paginate', '--slurp',
      `repos/${repo}/issues/${issue.number}/comments?per_page=100`]));
    previous = lastFineStatus([{ body: issue.body, user: issue.author }, ...pages.flat()]);
  }
  if (JSON.stringify(previous) === JSON.stringify(missing)) return 'unchanged';

  const url = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const body = missing.length
    ? `${DEGRADED} ${url}\n\nThe LANUK export lacked ${missing.join(', ')} — available products were mirrored; the missing fine series were skipped. Stored data is retained.`
    : `${RECOVERED} ${url}\n\nAll LANUK fine-series tables were imported again; consistency checks and both data pushes succeeded.`;
  if (issue) {
    gh(['api', '--method', 'POST', `repos/${repo}/issues/${issue.number}/comments`, '--input', '-'], JSON.stringify({ body }));
    return 'reported';
  }
  gh(['label', 'create', 'data-freshness', '--repo', repo, '--force', '--color', 'B60205',
    '--description', 'Data pipeline freshness / failure watchdog']);
  gh(['api', '--method', 'POST', `repos/${repo}/issues`, '--input', '-'], JSON.stringify({
    title: 'Data pipeline degraded: LANUK fine series missing', labels: ['data-freshness'], body,
  }));
  return 'created';
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(`nrw fine status: ${main()}`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
