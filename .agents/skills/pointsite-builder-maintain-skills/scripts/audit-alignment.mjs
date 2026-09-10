#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const pipelineSkillNames = [
  'pointsite-builder-create-issue',
  'pointsite-builder-audit-issues',
  'pointsite-builder-work-issue',
  'pointsite-builder-review-issue',
  'pointsite-builder-release-production',
  'pointsite-builder-close-issue',
  'pointsite-builder-pipeline-health',
  'pointsite-builder-maintain-skills',
];
const sharedDesignSkillNames = [
  'awesome-design',
  'design-taste-frontend',
  'image-to-code',
  'playwright-cli',
  'web-design-guidelines',
];
const pipelinerSkillNames = [
  'pipeliner-adopt',
  'pipeliner-update',
  'pipeliner-monitor-updates',
  'pipeliner-create-issue',
  'pipeliner-audit-backlog',
  'pipeliner-work-issue',
  'pipeliner-review-issue',
  'pipeliner-release-candidate',
  'pipeliner-release-production',
  'pipeliner-close-issue',
  'pipeliner-pipeline-health',
  'pipeliner-maintain',
];
const skillNames = [...pipelineSkillNames, ...sharedDesignSkillNames, ...pipelinerSkillNames];
const errors = [];

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`missing ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireText(content, needle, owner) {
  if (!content.includes(needle)) errors.push(`${owner} does not contain ${JSON.stringify(needle)}`);
}

const agents = read('AGENTS.md');
const claude = read('CLAUDE.md').trim();
const gemini = read('GEMINI.md').trim();
const policyPath = '.agents/pointsite-builder-pipeline-policy.html';
const policy = read(policyPath);
const packageJson = JSON.parse(read('package.json') || '{}');
const qualityWorkflow = read('.github/workflows/quality.yml');

if (claude !== '@AGENTS.md') errors.push('CLAUDE.md must contain only @AGENTS.md');
if (gemini !== '@./AGENTS.md') errors.push('GEMINI.md must contain only @./AGENTS.md');
requireText(policy, 'color-scheme: dark', policyPath);
requireText(policy, 'Approved to create this exact GitHub Issue', policyPath);
requireText(policy, 'Private PointCommunity Project <code>PointSite Builder</code>', policyPath);
requireText(policy, 'Backlog, On Hold, In Progress, In Review, Done', policyPath);
requireText(policy, 'Agent-owned Project movement', policyPath);
requireText(policy, 'Pull request merged', policyPath);
requireText(policy, 'is disabled', policyPath);
requireText(policy, 'Production only at', policyPath);
requireText(
  policy,
  'PM approval is instead the mandatory post-deployment completion gate.',
  policyPath,
);
requireText(policy, 'Production Showcase and PM acceptance', policyPath);
requireText(policy, 'Approved to complete Issue #&lt;number&gt;', policyPath);
requireText(agents, 'Exactly one Issue may be active', 'AGENTS.md');
requireText(agents, 'Never ask the PM to move a Project card', 'AGENTS.md');
requireText(agents, 'It has no Builder staging or Canary environment', 'AGENTS.md');
requireText(agents, 'deploy the exact clean `origin/main` revision', 'AGENTS.md');
requireText(
  agents,
  'Agent QA and live verification never substitute for PM review and testing',
  'AGENTS.md',
);
requireText(agents, 'Approved to complete Issue #<number>', 'AGENTS.md');
requireText(agents, 'Do not create or open a standalone acceptance report', 'AGENTS.md');
requireText(policy, 'Lean completion evidence', policyPath);
requireText(policy, 'Do not create or open a standalone acceptance', policyPath);

const transitionContracts = {
  'pointsite-builder-create-issue': 'never ask the PM to add or move the card',
  'pointsite-builder-work-issue': 'agent-owned Project transition',
  'pointsite-builder-review-issue': 'agent-owned Project transition',
  'pointsite-builder-close-issue': 'agent-owned Project transition',
};
for (const [skillName, contract] of Object.entries(transitionContracts)) {
  requireText(
    read(`.agents/skills/${skillName}/SKILL.md`),
    contract,
    `.agents/skills/${skillName}/SKILL.md`,
  );
}

const leanCloseoutContracts = {
  'pointsite-builder-create-issue': 'Do not require a standalone acceptance report',
  'pointsite-builder-work-issue': 'Do not create or open a standalone acceptance report',
  'pointsite-builder-review-issue': 'Do not create or open a standalone acceptance report',
  'pointsite-builder-close-issue': 'Do not create or open a standalone acceptance report',
  'pointsite-builder-release-production': 'Do not duplicate this evidence into a standalone report',
};
for (const [skillName, contract] of Object.entries(leanCloseoutContracts)) {
  requireText(
    read(`.agents/skills/${skillName}/SKILL.md`),
    contract,
    `.agents/skills/${skillName}/SKILL.md`,
  );
}

const showcaseContracts = {
  'pointsite-builder-review-issue': 'Production Showcase',
  'pointsite-builder-close-issue': 'Approved to complete Issue #<number>',
  'pointsite-builder-release-production': 'production health does not replace PM testing',
};
for (const [skillName, contract] of Object.entries(showcaseContracts)) {
  requireText(
    read(`.agents/skills/${skillName}/SKILL.md`),
    contract,
    `.agents/skills/${skillName}/SKILL.md`,
  );
}

for (const skillName of pipelineSkillNames) {
  requireText(agents, `\`${skillName}\``, 'AGENTS.md');
}
for (const skillName of sharedDesignSkillNames) {
  requireText(agents, `\`${skillName}\``, 'AGENTS.md');
}

for (const skillName of skillNames) {
  const canonicalRelative = `.agents/skills/${skillName}/SKILL.md`;
  const canonical = read(canonicalRelative);
  const frontmatter = canonical.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) {
    errors.push(`${canonicalRelative} has invalid frontmatter`);
  } else {
    requireText(frontmatter[1], `name: ${skillName}`, canonicalRelative);
    if (!/^description:\s*.+$/m.test(frontmatter[1])) {
      errors.push(`${canonicalRelative} has no description`);
    }
  }

  const adapterRelative = `.claude/skills/${skillName}/SKILL.md`;
  const adapterPath = path.join(repoRoot, adapterRelative);
  const adapter = read(adapterRelative);
  if (fs.existsSync(adapterPath) && fs.lstatSync(adapterPath).isSymbolicLink()) {
    errors.push(`${adapterRelative} must be a regular file, not a symlink`);
  }
  requireText(adapter, `name: ${skillName}`, adapterRelative);
  requireText(adapter, `../../../.agents/skills/${skillName}/SKILL.md`, adapterRelative);
}

const canonicalRoot = path.join(repoRoot, '.agents/skills');
if (fs.existsSync(canonicalRoot)) {
  const actual = fs
    .readdirSync(canonicalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = [...skillNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `canonical skill registry mismatch: expected ${expected.join(', ')}; found ${actual.join(', ')}`,
    );
  }
}

const expectedScripts = {
  'skills:check':
    'node --test .agents/skills/pointsite-builder-maintain-skills/scripts/pipeline-scripts.test.mjs scripts/pipeliner-contracts.test.mjs && node .agents/skills/pointsite-builder-maintain-skills/scripts/audit-alignment.mjs && node scripts/validate-repository.mjs',
  'pipeline:health':
    'node .agents/skills/pointsite-builder-pipeline-health/scripts/audit-pipeline.mjs',
  'verify:live': 'node .agents/skills/pointsite-builder-release-production/scripts/verify-live.mjs',
};
for (const [name, command] of Object.entries(expectedScripts)) {
  if (packageJson.scripts?.[name] !== command)
    errors.push(`package.json ${name} is missing or misaligned`);
}
if (!packageJson.scripts?.check?.includes('npm run skills:check')) {
  errors.push('package.json check must include skills:check');
}
requireText(qualityWorkflow, 'npm run skills:check', '.github/workflows/quality.yml');
requireText(agents, 'direct framework maintenance', 'AGENTS.md');
requireText(qualityWorkflow, 'npm ci --ignore-scripts', '.github/workflows/quality.yml');
if (
  /run:.*(?:npm run (?:build|test:e2e|test:performance|test:coverage|check)|playwright install)/.test(
    qualityWorkflow,
  )
) {
  errors.push('application QA must remain local; lightweight Actions cannot build the application');
}

for (const relativePath of [
  '.agents/skills/pointsite-builder-maintain-skills/scripts/pipeline-scripts.test.mjs',
  '.agents/skills/pointsite-builder-pipeline-health/scripts/audit-pipeline.mjs',
  '.agents/skills/pointsite-builder-release-production/scripts/verify-live.mjs',
]) {
  read(relativePath);
}

if (errors.length > 0) {
  console.error(`PointSite Builder skill alignment failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `PointSite Builder skill alignment OK: ${pipelineSkillNames.length} workflow skills, ${sharedDesignSkillNames.length} shared design skills, and ${skillNames.length} Claude adapters.`,
);
