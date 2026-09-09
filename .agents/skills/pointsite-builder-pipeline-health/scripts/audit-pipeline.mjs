#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const OWNER = 'PointCommunity';
const REPO = `${OWNER}/pointsite-builder`;
const PROJECT_NUMBER = '1';
const PROJECT_TITLE = 'PointSite Builder';
const ACTIVE = new Set(['In Progress', 'In Review']);
const REQUIRED_STATUS = ['Backlog', 'On Hold', 'In Progress', 'In Review', 'Done'];
const REQUIRED_FIELDS = {
  Priority: ['P0', 'P1', 'P2', 'P3'],
  Impact: ['High', 'Medium', 'Low'],
  Effort: ['XS', 'S', 'M', 'L', 'XL'],
};
const REQUIRED_VIEWS = ['Backlog', 'Kanban'];
const REQUIRED_WORKFLOWS = {
  'Auto-add sub-issues to project': true,
  'Auto-close issue': true,
  'Item added to project': true,
  'Item closed': true,
  'Pull request linked to issue': true,
  'Pull request merged': false,
};
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

function optionNames(fields, fieldName) {
  return (
    fields.find((field) => field.name === fieldName)?.options?.map((option) => option.name) ?? []
  );
}

export function auditPipelineSnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  const issues = snapshot.issues ?? [];
  const prs = snapshot.prs ?? [];
  const issueItems = (snapshot.items ?? []).filter((item) => item.content?.type === 'Issue');
  const itemByNumber = new Map(issueItems.map((item) => [item.content.number, item]));
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const activeItems = issueItems.filter((item) => ACTIVE.has(item.status));
  const dependabotPrs = prs.filter(isDependabot);
  const allPipelinePrs = prs.filter((pr) => !isDependabot(pr));
  const pipelinePrs = allPipelinePrs.filter((pr) => !pr.state || pr.state === 'OPEN');

  if (
    snapshot.project?.title !== PROJECT_TITLE ||
    snapshot.project?.public !== false ||
    snapshot.project?.closed !== false
  ) {
    errors.push(`Project must be the open private ${OWNER}/${PROJECT_TITLE} Project`);
  }
  if (
    JSON.stringify(optionNames(snapshot.fields ?? [], 'Status')) !== JSON.stringify(REQUIRED_STATUS)
  ) {
    errors.push(
      `Status options mismatch: ${optionNames(snapshot.fields ?? [], 'Status').join(', ')}`,
    );
  }
  for (const [fieldName, expectedOptions] of Object.entries(REQUIRED_FIELDS)) {
    const actual = optionNames(snapshot.fields ?? [], fieldName);
    if (JSON.stringify(actual) !== JSON.stringify(expectedOptions)) {
      errors.push(`${fieldName} options mismatch: ${actual.join(', ')}`);
    }
  }

  const repositories = snapshot.repositories ?? [];
  if (JSON.stringify(repositories) !== JSON.stringify([REPO])) {
    errors.push(`Project repository link mismatch: ${repositories.join(', ') || 'none'}`);
  }
  const views = snapshot.views ?? [];
  for (const requiredName of REQUIRED_VIEWS) {
    const view = views.find((candidate) => candidate.name === requiredName);
    if (!view || view.layout !== 'BOARD_LAYOUT' || view.verticalGroupBy !== 'Status') {
      errors.push(`${requiredName} must be a board view grouped by Status`);
    }
  }
  const unexpectedViews = views.filter((view) => !REQUIRED_VIEWS.includes(view.name));
  if (unexpectedViews.length > 0) {
    errors.push(`unexpected Project views: ${unexpectedViews.map((view) => view.name).join(', ')}`);
  }
  const workflows = snapshot.workflows ?? [];
  for (const [requiredName, expectedEnabled] of Object.entries(REQUIRED_WORKFLOWS)) {
    const workflow = workflows.find((candidate) => candidate.name === requiredName);
    if (!workflow || workflow.enabled !== expectedEnabled) {
      errors.push(
        `Project workflow ${requiredName} must be ${expectedEnabled ? 'enabled' : 'disabled'}`,
      );
    }
  }

  const liveLabelNames = new Set((snapshot.availableLabels ?? []).map((label) => label.name));
  for (const requiredPrefix of ['type:', 'area:']) {
    if (![...liveLabelNames].some((name) => name.startsWith(requiredPrefix))) {
      errors.push(`repository is missing governed ${requiredPrefix} labels`);
    }
  }

  if (snapshot.statusPorcelain) warnings.push('local worktree has uncommitted changes');
  if (snapshot.branch === 'main' && snapshot.head !== snapshot.remoteMain) {
    errors.push('local main does not match remote main');
  }
  if (snapshot.branchProtection === 'unavailable-private-plan') {
    warnings.push(
      'GitHub branch rules are unavailable for this private repository on the current plan',
    );
  }
  if (activeItems.length > 1) {
    errors.push(
      `single-active-Issue violation: ${activeItems.map((item) => `#${item.content.number}`).join(', ')}`,
    );
  }

  for (const issue of issues) {
    const item = itemByNumber.get(issue.number);
    if (!item) {
      errors.push(`open Issue #${issue.number} is missing from the Project`);
      continue;
    }
    for (const fieldName of ['status', 'priority', 'impact', 'effort']) {
      if (!item[fieldName]) errors.push(`Issue #${issue.number} is missing ${fieldName}`);
    }
    if (item.status === 'Done')
      errors.push(`open Issue #${issue.number} must not have Status Done`);

    const names = labelNames(issue);
    const typeLabels = names.filter((name) => name.startsWith('type:'));
    const areaLabels = names.filter((name) => name.startsWith('area:'));
    if (typeLabels.length !== 1)
      errors.push(`Issue #${issue.number} must have exactly one type label`);
    if (areaLabels.length < 1)
      errors.push(`Issue #${issue.number} must have at least one area label`);

    const assignees = (issue.assignees ?? []).map((assignee) => assignee.login);
    if (ACTIVE.has(item.status)) {
      if (assignees.length !== 1 || assignees[0] !== 'brimdor') {
        errors.push(`active Issue #${issue.number} must be assigned only to brimdor`);
      }
    } else if (item.status === 'Backlog' && assignees.length > 0) {
      errors.push(`Backlog Issue #${issue.number} must be unassigned`);
    }
  }

  for (const item of issueItems) {
    if (!issueByNumber.has(item.content.number) && item.status !== 'Done') {
      errors.push(`closed Issue #${item.content.number} must have Status Done`);
    }
  }

  for (const pr of pipelinePrs) {
    if (AUTO_CLOSE_PATTERN.test(pr.body ?? '')) {
      errors.push(`PR #${pr.number} contains forbidden auto-close syntax`);
    }
    const refs = refsFrom(pr.body);
    if (refs.length !== 1) {
      errors.push(`PR #${pr.number} must reference exactly one Issue with Refs #N`);
      continue;
    }
    const issueNumber = refs[0];
    const item = itemByNumber.get(issueNumber);
    if (!item) {
      errors.push(`PR #${pr.number} references Issue #${issueNumber}, which is not in the Project`);
      continue;
    }
    if (pr.baseRefName !== 'main') errors.push(`PR #${pr.number} must target main`);
    if (!(pr.headRefName ?? '').startsWith(`issue/${issueNumber}-`)) {
      errors.push(`PR #${pr.number} branch must start with issue/${issueNumber}-`);
    }
    if (!ACTIVE.has(item.status)) {
      errors.push(`PR #${pr.number} references Issue #${issueNumber}, which is not active`);
    }
  }

  for (const item of activeItems.filter((candidate) => candidate.status === 'In Review')) {
    const matching = allPipelinePrs
      .filter((pr) => refsFrom(pr.body).includes(item.content.number))
      .sort((left, right) => right.number - left.number);
    if (matching.length < 1) {
      errors.push(`In Review Issue #${item.content.number} must have a referenced PR`);
      continue;
    }
    const pr = matching[0];
    if (pr.state && !['OPEN', 'MERGED'].includes(pr.state)) {
      errors.push(`In Review PR #${pr.number} must be open or merged for the production Showcase`);
    }
    if (pr.isDraft) errors.push(`In Review PR #${pr.number} must be ready for review`);
    const checks = pr.statusCheckRollup ?? [];
    if (checks.length === 0)
      errors.push(`In Review PR #${pr.number} has no GitHub Quality evidence`);
    if (checks.some((check) => check.status !== 'COMPLETED')) {
      errors.push(`In Review PR #${pr.number} has pending GitHub checks`);
    }
    if (
      checks.some(
        (check) =>
          check.conclusion && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion),
      )
    ) {
      errors.push(`In Review PR #${pr.number} has failed GitHub checks`);
    }
  }

  return { errors, warnings, activeItems, pipelinePrs, dependabotPrs };
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
  return output ? JSON.parse(output) : {};
}

function readBranchProtection() {
  try {
    run('gh', ['api', `repos/${REPO}/rulesets`]);
    return 'available';
  } catch (error) {
    if (String(error).includes('Upgrade to GitHub Pro or make this repository public')) {
      return 'unavailable-private-plan';
    }
    throw error;
  }
}

export function readLiveSnapshot() {
  const remoteLine = run('git', ['ls-remote', 'origin', 'refs/heads/main']);
  const remoteMain = remoteLine.split(/\s+/)[0] ?? '';
  const project = runJson('gh', [
    'project',
    'view',
    PROJECT_NUMBER,
    '--owner',
    OWNER,
    '--format',
    'json',
  ]);
  const fieldData = runJson('gh', [
    'project',
    'field-list',
    PROJECT_NUMBER,
    '--owner',
    OWNER,
    '--limit',
    '100',
    '--format',
    'json',
  ]);
  const itemData = runJson('gh', [
    'project',
    'item-list',
    PROJECT_NUMBER,
    '--owner',
    OWNER,
    '--limit',
    '100',
    '--format',
    'json',
  ]);
  const projectConfiguration = runJson('gh', [
    'api',
    'graphql',
    '-f',
    'query=query { organization(login: "PointCommunity") { projectV2(number: 1) { repositories(first: 20) { nodes { nameWithOwner } } workflows(first: 20) { nodes { name enabled } } views(first: 20) { nodes { name layout verticalGroupByFields(first: 5) { nodes { ... on ProjectV2SingleSelectField { name } } } } } } } }',
  ]).data.organization.projectV2;

  return {
    project,
    fields: fieldData.fields ?? [],
    items: itemData.items ?? [],
    repositories: projectConfiguration.repositories.nodes.map((repo) => repo.nameWithOwner),
    workflows: projectConfiguration.workflows.nodes,
    views: projectConfiguration.views.nodes.map((view) => ({
      name: view.name,
      layout: view.layout,
      verticalGroupBy: view.verticalGroupByFields.nodes[0]?.name ?? null,
    })),
    branch: run('git', ['branch', '--show-current']),
    head: run('git', ['rev-parse', 'HEAD']),
    remoteMain,
    statusPorcelain: run('git', ['status', '--porcelain']),
    branchProtection: readBranchProtection(),
    availableLabels: runJson('gh', [
      'label',
      'list',
      '--repo',
      REPO,
      '--limit',
      '200',
      '--json',
      'name,color,description',
    ]),
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
      'all',
      '--limit',
      '100',
      '--json',
      'number,title,body,state,mergedAt,isDraft,headRefName,baseRefName,statusCheckRollup,url',
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
  const active = result.activeItems[0]
    ? `#${result.activeItems[0].content.number} ${result.activeItems[0].status}`
    : 'none';
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
