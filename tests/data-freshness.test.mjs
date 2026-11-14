import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessProblems, lastFreshnessStatus, reportFreshness, main } from '../scripts/check-data-freshness.mjs';
import { MONTHLY_PROTOCOL } from '../scripts/archive-monthly-pass.mjs';
import { tracker } from './fixtures/freshness-tracker.mjs';
const now = new Date('2026-11-14T12:00:00Z');
const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42' };
const bot = body => ({ body, user: { login: 'github-actions[bot]' } });
const healthy = () => ({ archiveDate: now.toISOString(), nrwDate: now.toISOString(),
  overview: { generated: now.toISOString() }, manifest: { generated: now.toISOString() },
  status: { monthly: { period: '2026-11', completedAt: '2026-11-09T12:00:00Z', protocol: MONTHLY_PROTOCOL } } });
const ids = input => freshnessProblems(input, now).map(p => p.id);

test('fresh weekly timestamps do not hide an overdue monthly ZIP pass', () => {
  assert.deepEqual(ids(healthy()), []);
  const d = healthy(); delete d.status;
  assert.deepEqual(ids(d), ['archive-monthly']);
  assert.match(freshnessProblems(d, now)[0].text, /first Monday, retried on later Mondays/);
  assert.doesNotMatch(freshnessProblems(d, now)[0].text, /the 3rd/);
});

test('each freshness check has its own stable ID; missing and future data cannot pass', () => {
  assert.deepEqual(ids({ ...healthy(), archiveDate: '2026-11-12T23:59:00Z' }), ['archive-branch']);
  assert.deepEqual(ids({ ...healthy(), overview: { generated: '2026-11-14T05:59:00Z' } }), ['deploy']);
  assert.deepEqual(ids({ ...healthy(), manifest: { generated: '2026-11-04T11:59:00Z' } }), ['archive-refresh']);
  assert.deepEqual(ids({ ...healthy(), nrwDate: undefined }), ['nrw']);
  assert.deepEqual(ids({ ...healthy(), overview: null }), ['deploy']);
  assert.deepEqual(ids({ ...healthy(), overview: { generated: '2026-11-15T00:00:00Z' } }), ['deploy']);
  assert.deepEqual(ids({ ...healthy(), manifest: null }), ['archive-refresh']);
  assert.ok(ids({ ...healthy(), archiveDate: 'bad' }).includes('archive-branch'));
});

test('monthly watchdog allows two days of drift, then demands this month; January uses December before first Monday', () => {
  const d = healthy(); d.status.monthly = { period: '2026-10', completedAt: '2026-10-12T12:00:00Z', protocol: MONTHLY_PROTOCOL };
  const check = date => freshnessProblems({ ...d, archiveDate: date, nrwDate: date,
    overview: { generated: date }, manifest: { generated: date } }, new Date(date));
  assert.deepEqual(check('2026-11-03T23:59:59Z'), []);
  assert.deepEqual(check('2026-11-04T00:00:00Z').map(p => p.id), ['archive-monthly']);
  d.status.monthly = { period: '2026-12', completedAt: '2026-12-07T12:00:00Z', protocol: MONTHLY_PROTOCOL };
  assert.deepEqual(check('2027-01-03T12:00:00Z'), []);
  assert.deepEqual(check('2027-01-06T00:00:00Z').map(p => p.id), ['archive-monthly']);
});

test('repeating problems stay quiet despite changing ages; changed sets and recovery each report once', () => {
  const t = tracker();
  const report = problems => reportFreshness(problems, { env, gh: t.gh });
  assert.equal(report([{ id: 'archive-refresh', text: '11 days old' }]), 'reported');
  assert.equal(report([{ id: 'archive-refresh', text: '12 days old' }]), 'unchanged');
  assert.equal(report([{ id: 'archive-refresh', text: '13 days old' }, { id: 'nrw', text: 'stale' }]), 'reported');
  assert.equal(report([{ id: 'nrw', text: 'still stale' }, { id: 'archive-refresh', text: '14 days old' }]), 'unchanged');
  assert.equal(report([]), 'reported');
  assert.equal(report([]), 'unchanged');
  assert.equal(report([{ id: 'nrw', text: 'new outage' }]), 'reported');
  assert.equal(t.writes.length, 4);
});

test('legacy warnings migrate without repeating the old finding; unrelated messages never reset status', () => {
  const old = bot('Still stale: The archive refresh has not completed in 13 days.');
  const comments = [old, bot('nrw-update fine series recovered: url'), { ...old, user: { login: 'someone' } }];
  assert.deepEqual(lastFreshnessStatus(comments), ['archive-refresh']);
  const t = tracker({ pages: [[old], comments.slice(1)] });
  assert.equal(reportFreshness([{ id: 'archive-refresh', text: '20 days old' }], { env, gh: t.gh }), 'unchanged');
  assert.equal(reportFreshness([], { env, gh: t.gh }), 'reported');
  assert.equal(reportFreshness([], { env, gh: t.gh }), 'unchanged');
  assert.throws(() => lastFreshnessStatus([bot('<!-- data-freshness: [bad] -->')]), SyntaxError);
});

test('healthy watchdog creates no issue or label; a new outage does and its issue body records state', () => {
  const t = tracker({ issue: null });
  assert.equal(reportFreshness([], { env, gh: t.gh }), 'unchanged');
  assert.equal(t.calls.length, 1);
  assert.equal(reportFreshness([{ id: 'nrw', text: 'stale' }], { env, gh: t.gh }), 'created');
  assert.equal(reportFreshness([{ id: 'nrw', text: 'still stale' }], { env, gh: t.gh }), 'unchanged');
  assert.equal(reportFreshness([], { env, gh: t.gh }), 'reported');
  assert.equal(t.writes.length, 2);
});

test('watchdog main reads deployed data with cache busting and posts only transitions', async () => {
  const t = tracker({ issue: null });
  const fetched = [];
  const gh = (args, input) => args[0] === 'api' && args[1].includes('/branches/')
    ? JSON.stringify({ commit: { commit: { committer: { date: now.toISOString() } } } }) : t.gh(args, input);
  const fetchImpl = async url => {
    fetched.push(url);
    return new Response(JSON.stringify(url.includes('pipeline-status') ? healthy().status : { generated: now.toISOString() }));
  };
  assert.equal(await main([], { env, gh, fetchImpl, now }), 'unchanged');
  assert.equal(fetched.length, 3);
  assert.ok(fetched.every(url => url.startsWith('https://owner.github.io/repo/archive/') && url.endsWith('?cb=42')));
  const bad = async () => new Response('', { status: 404 });
  assert.equal(await main([], { env, gh, fetchImpl: bad, now }), 'created');
  assert.equal(await main([], { env, gh, fetchImpl: bad, now }), 'unchanged');
  assert.equal(t.writes.length, 1);
});

test('GitHub authentication failure is not a missing branch; invalid CLI never reaches the network', async () => {
  const gh = args => {
    if (args[1].endsWith('/archive')) return '{"commit":{"commit":{"committer":{"date":"2026-11-14T12:00:00Z"}}}}';
    throw Object.assign(new Error('denied'), { stderr: 'HTTP 403' });
  };
  await assert.rejects(main([], { env, gh, now }), /denied/);
  const noNetwork = () => assert.fail('must not access GitHub');
  await assert.rejects(main(['--nope'], { env, gh: noNetwork }), /usage/);
  await assert.rejects(main([], { env: {}, gh: noNetwork }), /GITHUB_REPOSITORY/);
});

test('missing archive/NRW branches are findings, not a silently aborted watchdog', async () => {
  const t = tracker();
  const gh = (args, input) => {
    if (args[0] === 'api' && args[1].includes('/branches/')) throw Object.assign(new Error('missing'), { stderr: 'HTTP 404' });
    return t.gh(args, input);
  };
  const fetchImpl = async url => new Response(JSON.stringify(url.includes('pipeline-status') ? healthy().status : { generated: now.toISOString() }));
  assert.equal(await main([], { env, gh, fetchImpl, now }), 'reported');
  assert.match(t.writes[0], /"archive-branch","deploy","nrw"/);
});
