#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'PointCommunity/pointsite-builder';
const PRIMARY_LABELS = new Set(['bug', 'enhancement', 'documentation', 'question']);
const AUTO_CLOSE_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/i;

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
}

function refsFrom(body) {
  return [...(body ?? '').matchAll(/\bRefs\s+#(\d+)/gi)].map((match) => Number(match[1]));
}

function isDependabot(pr) {
  return (pr.headRefName ?? '').startsWith('dependabot/');
}

function isPipelinePr(pr) {
  return (pr.headRefName ?? '').startsWith('issue/') || refsFrom(pr.body).length > 0;
}

export function auditPipelineSnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  const issues = snapshot.issues ?? [];
  const prs = snapshot.prs ?? [];
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const activeIssues = issues.filter((issue) =>
    (issue.assignees ?? []).some((assignee) => assignee.login === 'brimdor'),
  );
  const dependabotPrs = prs.filter(isDependabot);
  const pipelinePrs = prs.filter((pr) => !isDependabot(pr) && isPipelinePr(pr));

  if (snapshot.statusPorcelain) warnings.push('local worktree has uncommitted changes');
  if (snapshot.branch === 'main' && snapshot.head !== snapshot.remoteMain) {
    errors.push('local main does not match remote main');
  }
  if (activeIssues.length > 1) {
    errors.push(
      `active-Issue violation: ${activeIssues.map((issue) => `#${issue.number}`).join(', ')}`,
    );
  }

  for (const issue of issues) {
    const primary = labelNames(issue).filter((name) => PRIMARY_LABELS.has(name));
    if (primary.length !== 1) {
      errors.push(`Issue #${issue.number} must have exactly one primary classification label`);
    }
    const assignees = (issue.assignees ?? []).map((assignee) => assignee.login);
    if (assignees.includes('brimdor') && (assignees.length !== 1 || assignees[0] !== 'brimdor')) {
      errors.push(`active Issue #${issue.number} must be assigned only to brimdor`);
    }
  }

  if (pipelinePrs.length > 1) {
    errors.push(
      `multiple workflow PRs are open: ${pipelinePrs.map((pr) => `#${pr.number}`).join(', ')}`,
    );
  }
  for (const pr of pipelinePrs) {
    if (pr.baseRefName !== 'main') errors.push(`PR #${pr.number} must target main`);
    if (AUTO_CLOSE_PATTERN.test(pr.body ?? '')) {
      errors.push(`PR #${pr.number} contains forbidden auto-close syntax`);
    }
    const refs = refsFrom(pr.body);
    if (refs.length !== 1) {
      errors.push(`PR #${pr.number} must reference exactly one Issue with Refs #N`);
      continue;
    }
    const issueNumber = refs[0];
    const issue = issueByNumber.get(issueNumber);
    if (!issue) {
      errors.push(`PR #${pr.number} references missing open Issue #${issueNumber}`);
      continue;
    }
    if (!(pr.headRefName ?? '').startsWith(`issue/${issueNumber}-`)) {
      errors.push(`PR #${pr.number} branch must start with issue/${issueNumber}-`);
    }
    if (!(issue.assignees ?? []).some((assignee) => assignee.login === 'brimdor')) {
      errors.push(`PR #${pr.number} references Issue #${issueNumber}, which is not active`);
    }

    const checks = pr.statusCheckRollup ?? [];
    const failedChecks = checks.filter(
      (check) =>
        check.status === 'COMPLETED' &&
        check.conclusion &&
        !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion),
    );
    if (failedChecks.length > 0) errors.push(`PR #${pr.number} has failed GitHub checks`);
    if (checks.some((check) => check.status !== 'COMPLETED')) {
      warnings.push(`PR #${pr.number} has pending GitHub checks`);
    }
  }

  return { errors, warnings, activeIssues, pipelinePrs, dependabotPrs };
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function runJson(command, args) {
  const output = run(command, args);
  return output ? JSON.parse(output) : [];
}

export function readLiveSnapshot() {
  const remoteLine = run('git', ['ls-remote', 'origin', 'refs/heads/main']);
  const remoteMain = remoteLine.split(/\s+/)[0] ?? '';
  return {
    branch: run('git', ['branch', '--show-current']),
    head: run('git', ['rev-parse', 'HEAD']),
    remoteMain,
    statusPorcelain: run('git', ['status', '--porcelain']),
    issues: runJson('gh', [
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,labels,assignees,url',
    ]),
    prs: runJson('gh', [
      'pr',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,body,headRefName,baseRefName,statusCheckRollup,url',
    ]),
  };
}

async function main() {
  const result = auditPipelineSnapshot(readLiveSnapshot());
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  if (result.errors.length > 0) {
    process.stderr.write(`PointSite Builder pipeline health failed (${result.errors.length}):\n`);
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const active = result.activeIssues[0] ? `#${result.activeIssues[0].number}` : 'none';
  process.stdout.write(
    `PointSite Builder pipeline health OK: active=${active}, ${result.pipelinePrs.length} workflow PR(s), ${result.dependabotPrs.length} Dependabot PR(s).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
