'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'sbom.cdx.json');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(path.dirname(output), { recursive: true });
childProcess.execFileSync(path.join(root, 'node_modules', '.bin', 'cyclonedx-npm'), [
  '--output-reproducible',
  '--spec-version', '1.6',
  '--output-format', 'JSON',
  '--output-file', output,
  '--validate'
], { cwd: root, stdio: 'inherit' });
const sbom = JSON.parse(fs.readFileSync(output, 'utf8'));
const addProperty = (component, name, value) => {
  component.properties ||= [];
  if (!component.properties.some(property => property.name === name)) component.properties.push({ name, value });
  component.properties.sort((a, b) => a.name.localeCompare(b.name));
};
const packageVersion = require(path.join(root, 'package.json')).version;
if (sbom.metadata?.component) {
  addProperty(sbom.metadata.component, 'auxillo:sbom-scope', 'Complete npm dependency graph plus packaged artifact hashes and required external Proton Drive CLI');
  const releaseFiles = [
    `Aux.Proton.Drive.Bridge-${packageVersion}-x86_64.AppImage`,
    `Aux.Proton.Drive.Bridge-${packageVersion}-amd64.deb`,
    `Aux.Proton.Drive.Bridge-${packageVersion}-x86_64.rpm`
  ];
  for (const name of releaseFiles) {
    const artifact = path.join(root, 'dist', name);
    if (!fs.existsSync(artifact)) throw new Error(`Cannot create release SBOM without ${name}`);
    addProperty(sbom.metadata.component, `auxillo:artifact-sha256:${name}`, digest(artifact));
  }
  const archive = path.join(root, 'dist', 'linux-unpacked', 'resources', 'app.asar');
  addProperty(sbom.metadata.component, 'auxillo:app-asar-sha256', digest(archive));
}
const patchScriptHash = digest(path.join(root, 'scripts', 'patch-dependency-compat.js'));
for (const component of sbom.components || []) {
  if (component.name === 'minimatch' && Number(component.version.split('.')[0]) < 9) {
    addProperty(component, 'auxillo:source-mutation', 'CommonJS compatibility adapter for brace-expansion 5.0.8');
    addProperty(component, 'auxillo:patch-script-sha256', patchScriptHash);
  }
}
const protonCli = {
  type: 'application',
  'bom-ref': 'pkg:generic/proton-drive-cli@0.6.0',
  name: 'proton-drive-cli',
  version: '0.6.0',
  description: 'Official external Proton Drive CLI required at runtime; not bundled',
  purl: 'pkg:generic/proton-drive-cli@0.6.0',
  properties: [{ name: 'auxillo:distribution', value: 'external runtime dependency' }]
};
if (!(sbom.components || []).some(component => component['bom-ref'] === protonCli['bom-ref'])) sbom.components.push(protonCli);
sbom.components.sort((a, b) => String(a['bom-ref'] || a.name).localeCompare(String(b['bom-ref'] || b.name)));
fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });
console.log(`Wrote ${path.relative(root, output)} with ${(sbom.components || []).length} components`);
