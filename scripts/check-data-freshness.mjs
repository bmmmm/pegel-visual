#!/usr/bin/env node
// Stable problem IDs, rather than changing age counters, define transitions.
// The watchdog owns this status only; pipeline failure and LANUK fine-series
// reports in the shared issue remain independent.
import { pathToFileURL } from 'node:url';
import { pinnedNow } from './lib/cli.mjs';
import { reportIssueChange, runGh, isActionsBot } from './lib/freshness-issue.mjs';
import { firstMonday, monthlyCurrent, duePeriod, ARCHIVE_CADENCE } from './archive-monthly-pass.mjs';

const MARKER = /<!-- data-freshness: (\[[^\n]*\]) -->/;
export function lastFreshnessStatus(comments) {
  for (const c of [...comments].reverse()) {
    if (!isActionsBot(c)) continue;
    const body = c.body || '';
    const marker = MARKER.exec(body);
    if (marker) {
      const state = JSON.parse(marker[1]);
      if (!Array.isArray(state) || state.some(k => typeof k !== 'string')) throw new Error('invalid freshness status');
      return [...new Set(state)].sort();
    }
    // Existing watchdog warnings, including its initial issue body. Neither
    // collector failures nor the LANUK reporter use these sentences.
    if (!body.startsWith('Still stale:') && !body.includes('Expected cadence:')) continue;
    const state = [];
    if (body.includes("The archive branch's last commit")) state.push('archive-branch');
    if (body.includes("The deployed site's overview.json")) state.push('deploy');
    if (body.includes('The archive refresh has not completed')) state.push('archive-refresh');
    if (body.includes("The nrw branch's last commit") || body.includes('The nrw branch does not exist')) state.push('nrw');
    if (state.length) return state.sort();
  }
  return [];
}

export function freshnessProblems({ archiveDate, nrwDate, overview, manifest, status }, now) {
  const age = stamp => {
    const t = Date.parse(stamp);
    return Number.isFinite(t) && t <= now.getTime() ? (now.getTime() - t) / 36e5 : Infinity;
  };
  const problems = [];
  if (age(archiveDate) > 36) problems.push({ id: 'archive-branch', text: `Archive branch is stale (last commit: ${archiveDate || 'unavailable'}; limit 36 hours).` });
  const branch = Date.parse(archiveDate), deployed = Date.parse(overview?.generated);
  if (!Number.isFinite(deployed) || deployed > now.getTime() || !Number.isFinite(branch) || branch - deployed > 6 * 36e5) {
    problems.push({ id: 'deploy', text: `Deployed overview is unavailable or more than 6 hours behind the archive branch (generated: ${overview?.generated || 'unavailable'}).` });
  }
  if (age(manifest?.generated) > 10 * 24) problems.push({ id: 'archive-refresh', text: `Archive refresh is overdue (manifest: ${manifest?.generated || 'unavailable'}; limit 10 days). Cadence: ${ARCHIVE_CADENCE}.` });
  // Two days of slack after the first Monday cover cron drift + the long pass.
  // Before then, the previous month's completed pass is the required one.
  const grace = now.getTime() < firstMonday(now).getTime() + 2 * 864e5;
  const required = grace ? duePeriod(new Date(firstMonday(now).getTime() - 1)) : duePeriod(now);
  if (!monthlyCurrent(status, required, now)) problems.push({ id: 'archive-monthly', text: `Full monthly WSV ZIP heal and gap sweep are overdue for ${required} (last verified pass: ${status?.monthly?.period || 'none'}). Cadence: ${ARCHIVE_CADENCE}.` });
  if (age(nrwDate) > 30) problems.push({ id: 'nrw', text: `LANUK mirror is stale or missing (last commit: ${nrwDate || 'unavailable'}; limit 30 hours). The next successful run can fetch only the remaining source window.` });
  return problems.sort((a, b) => a.id.localeCompare(b.id));
}

export function reportFreshness(problems, options) {
  const state = problems.map(p => p.id).sort();
  return reportIssueChange({ state, statusOf: lastFreshnessStatus, title: 'Data pipeline freshness needs attention',
    message: url => `${state.length ? 'Data freshness changed' : 'Data freshness recovered'}: ${url}\n\n`
      + (state.length ? problems.map(p => `- ${p.text}`).join('\n') : 'All watchdog freshness checks passed.')
      + `\n\n<!-- data-freshness: ${JSON.stringify(state)} -->`,
  }, options);
}

export async function main(argv = process.argv.slice(2), { env = process.env, gh = runGh, fetchImpl = fetch, now = pinnedNow() } = {}) {
  if (argv.length) throw new Error('usage: node scripts/check-data-freshness.mjs (no arguments)');
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  const branchDate = name => {
    try { return JSON.parse(gh(['api', `repos/${repo}/branches/${name}`])).commit.commit.committer.date; }
    catch (e) {
      // Authentication, rate limits and network errors are not a missing branch.
      if (!String(e.stderr).includes('HTTP 404')) throw e;
      return undefined;
    }
  };
  const archiveDate = branchDate('archive');
  const nrwDate = branchDate('nrw');
  const [owner, name] = repo.split('/');
  const base = `https://${owner}.github.io/${name}/archive`;
  const read = async path => {
    try {
      const res = await fetchImpl(`${base}/${path}?cb=${env.GITHUB_RUN_ID}`, { signal: AbortSignal.timeout(30000) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  };
  const [overview, manifest, status] = await Promise.all([
    read('totals/overview.json'), read('manifest.json'), read('pipeline-status.json'),
  ]);
  const problems = freshnessProblems({ archiveDate, nrwDate, overview, manifest, status }, now);
  for (const p of problems) console.log(`${p.id}: ${p.text}`);
  return reportFreshness(problems, { env, gh });
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(`data freshness: ${await main()}`); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
