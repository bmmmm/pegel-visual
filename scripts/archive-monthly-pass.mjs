#!/usr/bin/env node
// A weekly manifest refresh cannot stand in for the monthly ZIP heal + sweep.
// This checkpoint is committed with the data only after the whole pass and
// gate succeeded. A failed pass stays due on every subsequent weekly run.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, pinnedNow, writeJson } from './lib/cli.mjs';

export const MONTHLY_PROTOCOL = 'wsv-download-v2';
export const ARCHIVE_CADENCE = 'weekly on Monday; monthly on the first Monday, retried on later Mondays until successful';
export const monthOf = date => date.toISOString().slice(0, 7);
export function firstMonday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  d.setUTCDate(1 + (1 - d.getUTCDay() + 7) % 7);
  return d;
}
export function duePeriod(date) {
  return date >= firstMonday(date) ? monthOf(date)
    : monthOf(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}
export function monthlyCurrent(status, period, date) {
  const m = status?.monthly;
  const completed = Date.parse(m?.completedAt);
  return m?.protocol === MONTHLY_PROTOCOL && /^\d{4}-(0[1-9]|1[0-2])$/.test(m?.period || '')
    && m.period >= period && m.period <= monthOf(date)
    && Number.isFinite(completed) && completed <= date.getTime()
    && monthOf(new Date(completed)) === m.period;
}
export function readStatus(tree) {
  const path = join(tree, 'pipeline-status.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}
export function main(argv = process.argv.slice(2), { env = process.env, now = pinnedNow() } = {}) {
  const p = parseArgs(argv);
  for (const a of p.args.filter(a => a.startsWith('--'))) {
    if (!['--tree', '--force', '--complete', '--period'].includes(a)) throw new Error(`unknown flag ${a}`);
  }
  const tree = p.flag('tree');
  if (!tree) throw new Error('--tree is required');
  if (!existsSync(join(tree, 'manifest.json'))) throw new Error(`no manifest.json under ${tree}`);
  const status = readStatus(tree);
  const period = p.flag('period') || (p.has('force') ? monthOf(now) : duePeriod(now));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || period > monthOf(now)) throw new Error('invalid monthly period');
  if (p.has('complete')) {
    // Do not certify a previous month's failed pass as this month's success.
    if (period !== monthOf(now)) throw new Error('completed period must be the current month');
    writeJson(join(tree, 'pipeline-status.json'), { ...status, monthly: {
      period, completedAt: now.toISOString(), protocol: MONTHLY_PROTOCOL,
    } });
    return 'completed';
  }
  const monthly = p.has('force') || !monthlyCurrent(status, period, now);
  // Even when catching up an older missing period, this actual full-year heal
  // also satisfies the current month; future first-Monday runs need not repeat.
  const output = `monthly=${monthly}\nperiod=${monthOf(now)}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, output);
  console.log(output.trim());
  return monthly;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
