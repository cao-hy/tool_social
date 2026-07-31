import { spawnSync } from 'node:child_process';

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const minimumSeverity = severityRank.high;

const isWin = process.platform === 'win32';
const npmCommand = isWin ? 'npm.cmd' : 'npm';
const args = ['audit', '--json', '--audit-level=high'];

const result = isWin
  ? spawnSync(`${npmCommand} ${args.join(' ')}`, { encoding: 'utf8', shell: true })
  : spawnSync(npmCommand, args, { encoding: 'utf8', shell: false });

if (!result.stdout) {
  process.stderr.write(result.stderr || 'npm audit did not return JSON output.\n');
  process.exit(result.status || 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr || '');
  process.stderr.write(`Failed to parse npm audit JSON: ${error.message}\n`);
  process.exit(1);
}

const vulnerabilities = Object.entries(report.vulnerabilities || {}).filter(
  ([, vulnerability]) => severityRank[vulnerability.severity] >= minimumSeverity,
);

function viaList(vulnerability) {
  return (vulnerability.via || []).filter((entry) => typeof entry === 'object');
}

function viaNames(vulnerability) {
  return (vulnerability.via || [])
    .map((entry) => (typeof entry === 'object' ? entry.name : entry))
    .filter(Boolean);
}

function fixesByDowngradingNext(vulnerability) {
  const fix = vulnerability.fixAvailable;
  return (
    fix &&
    typeof fix === 'object' &&
    fix.name === 'next' &&
    typeof fix.version === 'string' &&
    fix.version.startsWith('14.')
  );
}

function isTemporarilyAllowed(packageName, vulnerability) {
  const nodes = vulnerability.nodes || [];
  const names = viaNames(vulnerability);

  if (
    packageName === 'postcss' &&
    nodes.every((node) => node === 'node_modules/next/node_modules/postcss') &&
    fixesByDowngradingNext(vulnerability)
  ) {
    return 'Next 15 currently pins postcss 8.4.31; npm only offers a breaking downgrade to Next 14.';
  }

  if (
    packageName === 'next' &&
    fixesByDowngradingNext(vulnerability) &&
    names.length > 0 &&
    names.every((name) => ['postcss', 'sharp', 'next'].includes(name))
  ) {
    return 'Next advisory has no non-breaking patched Next 15/16 release yet; keep tracking upstream.';
  }

  if (packageName === 'vite' || packageName === 'vitest') {
    return 'Vite and Vitest dev server vulnerabilities are temporarily allowed pending non-breaking upstream patches.';
  }

  return undefined;
}

const blocked = [];
const allowed = [];

for (const [packageName, vulnerability] of vulnerabilities) {
  const reason = isTemporarilyAllowed(packageName, vulnerability);
  if (reason) {
    allowed.push({ packageName, vulnerability, reason });
  } else {
    blocked.push({ packageName, vulnerability });
  }
}

for (const item of allowed) {
  console.warn(
    `::warning::Temporarily allowed npm audit finding: ${item.packageName} (${item.vulnerability.severity}). ${item.reason}`,
  );
}

if (blocked.length > 0) {
  for (const { packageName, vulnerability } of blocked) {
    const titles = viaList(vulnerability)
      .map((entry) => entry.title || entry.url || entry.name)
      .join('; ');
    console.error(
      `::error::Blocked npm audit finding: ${packageName} (${vulnerability.severity}) ${titles}`,
    );
  }
  process.exit(1);
}

console.log('npm audit passed: no unapproved high/critical vulnerabilities.');
