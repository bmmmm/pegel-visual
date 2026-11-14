#!/usr/bin/env node
// Called only after a successful nrw-update, including both data pushes.
// The issue's own reports are the durable state: no daily reminder, no new
// state file on a data branch, and a failed comment can be retried next run.
import { pathToFileURL } from 'node:url';
import { reportIssueChange, isActionsBot } from './lib/freshness-issue.mjs';

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
    if (!isActionsBot(c)) continue;
    const body = c.body || '';
    if (body.startsWith(RECOVERED)) return [];
    if (!body.startsWith(DEGRADED)) continue;
    const names = /^The LANUK export lacked ([\w., -]+) —/m.exec(body)?.[1];
    if (names) return normalize(names.split(','));
  }
  return [];
}

export function main(argv = process.argv.slice(2), { env = process.env, gh } = {}) {
  if (argv.length) throw new Error('usage: node scripts/report-nrw-fine-status.mjs (no arguments)');
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  }
  if (env.DEGRADED === undefined) throw new Error('DEGRADED must be set (empty for a complete run)');
  const missing = normalize(env.DEGRADED.split(','));
  return reportIssueChange({
    state: missing, statusOf: lastFineStatus, title: 'Data pipeline degraded: LANUK fine series missing',
    message: url => missing.length
    ? `${DEGRADED} ${url}\n\nThe LANUK export lacked ${missing.join(', ')} — available products were mirrored; the missing fine series were skipped. Stored data is retained.`
    : `${RECOVERED} ${url}\n\nAll LANUK fine-series tables were imported again; consistency checks and both data pushes succeeded.`,
  }, { env, gh });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(`nrw fine status: ${main()}`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
