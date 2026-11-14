// Shared issue transport. Each reporter owns its own status vocabulary;
// comments from other pipelines cannot acknowledge its incident.
import { execFileSync } from 'node:child_process';

export function runGh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
}

export const isActionsBot = c => ['github-actions[bot]', 'app/github-actions'].includes(c.user?.login);

export function reportIssueChange({ state, statusOf, title, message }, { env = process.env, gh = runGh } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  }
  const [issue] = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', 'data-freshness',
    '--state', 'open', '--limit', '1', '--json', 'number,body,author']));
  let previous = [];
  if (issue) {
    const pages = JSON.parse(gh(['api', '--paginate', '--slurp',
      `repos/${repo}/issues/${issue.number}/comments?per_page=100`]));
    previous = statusOf([{ body: issue.body, user: issue.author }, ...pages.flat()]);
  }
  if (JSON.stringify(previous) === JSON.stringify(state)) return 'unchanged';
  const url = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const body = message(url);
  if (issue) {
    gh(['api', '--method', 'POST', `repos/${repo}/issues/${issue.number}/comments`, '--input', '-'], JSON.stringify({ body }));
    return 'reported';
  }
  gh(['label', 'create', 'data-freshness', '--repo', repo, '--force', '--color', 'B60205',
    '--description', 'Data pipeline freshness / failure watchdog']);
  gh(['api', '--method', 'POST', `repos/${repo}/issues`, '--input', '-'], JSON.stringify({
    title, labels: ['data-freshness'], body,
  }));
  return 'created';
}
