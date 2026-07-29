'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const raw = childProcess.execFileSync('npm', ['query', ':not(.dev)', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
});
const queried = JSON.parse(raw);
const packages = [...new Map(queried
  .filter(info => path.resolve(info.path) !== root)
  .map(info => [`${info.name}@${info.version}`, info])).values()]
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

function repositoryUrl(repository) {
  if (!repository) return '';
  return typeof repository === 'string' ? repository : repository.url || '';
}

function licenseText(packagePath) {
  const entries = fs.readdirSync(packagePath).sort();
  const license = entries.find(name => /^(?:licen[cs]e|copying)(?:\..*)?$/i.test(name));
  if (!license) return '';
  const absolute = path.join(packagePath, license);
  if (!fs.statSync(absolute).isFile()) return '';
  return fs.readFileSync(absolute, 'utf8').trim().slice(0, 200_000);
}

const sections = packages.map(info => {
  const text = licenseText(info.path);
  if (!info.license || !text) throw new Error(`Missing license metadata or text for ${info.name}@${info.version}`);
  const repository = repositoryUrl(info.repository);
  return [
    `## ${info.name}@${info.version}`,
    '',
    `License: ${info.license}`,
    repository ? `Repository: ${repository}` : null,
    `\n\`\`\`text\n${text.replace(/```/g, '` ` `')}\n\`\`\``
  ].filter(Boolean).join('\n');
});
if (!sections.length) throw new Error('No production dependencies were discovered');
const output = [
  '# Third-Party Notices',
  '',
  'This file covers production npm dependencies bundled with Aux Proton Drive Bridge.',
  'Electron also ships its Chromium and Electron license notices beside the packaged executable.',
  '',
  ...sections,
  ''
].join('\n');
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), output, { mode: 0o644 });
console.log(`Wrote THIRD_PARTY_NOTICES.md for ${sections.length} production packages`);
