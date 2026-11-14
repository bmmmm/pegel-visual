import assert from 'node:assert/strict';
import { main } from '../../scripts/report-nrw-fine-status.mjs';
const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com' };
const bot = body => ({ body, user: { login: 'github-actions[bot]' } });

// Exercise the orchestration as well as the decision. No invocation can reach
// the real gh binary; unexpected calls fail, including closing the shared issue.
export function tracker({ issue = { number: 12 }, pages = [[]] } = {}) {
  const calls = [];
  const writes = [];
  let failRead = false;
  let failWrite = false;
  function gh(args, input) {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      if (failRead) throw new Error('GitHub unavailable');
      return JSON.stringify(issue ? [issue] : []);
    }
    if (args[0] === 'api' && args.includes('--paginate')) {
      assert.ok(args.includes('--slurp'));
      assert.equal(args.at(-1), 'repos/owner/repo/issues/12/comments?per_page=100');
      return JSON.stringify(pages);
    }
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
      if (failWrite) throw new Error('Comment write failed');
      const payload = JSON.parse(input);
      assert.deepEqual(args.slice(-2), ['--input', '-']);
      if (args[3] === 'repos/owner/repo/issues/12/comments') pages.at(-1).push(bot(payload.body));
      else {
        assert.equal(args[3], 'repos/owner/repo/issues');
        assert.deepEqual(payload.labels, ['data-freshness']);
        issue = { number: 12, body: payload.body, author: { login: 'app/github-actions', is_bot: true } };
      }
      writes.push(payload.body);
      return '{}';
    }
    assert.fail(`unexpected gh call: ${JSON.stringify(args)}`);
  }
  return { calls, writes, gh, failRead: () => { failRead = true; }, failWrite: value => { failWrite = value; },
    run: missing => main([], { env: { ...env, DEGRADED: missing }, gh }) };
}
