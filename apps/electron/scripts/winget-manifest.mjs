#!/usr/bin/env node
// Generate the three winget manifest files for a WinMux release, ready to submit to
// microsoft/winget-pkgs. Everything except the published installer URL + its SHA256 is
// derived from package.json, so the moment a release is published this is one command:
//
//   node scripts/winget-manifest.mjs \
//     --url https://github.com/Zbrooklyn/winmux/releases/download/v0.1.0/WinMux.Setup.0.1.0.exe \
//     --sha <sha256> [--out manifests/winget]
//
// Without --url/--sha it still writes a complete, valid-shaped manifest with PLACEHOLDER
// markers so the structure can be reviewed (and unit-tested) before the release exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const version = arg('version', pkg.version);
const publisherId = 'Zbrooklyn';
const packageName = (pkg.build && pkg.build.productName) || 'WinMux';
const identifier = publisherId + '.' + packageName;             // Zbrooklyn.WinMux
const url = arg('url', 'PLACEHOLDER_INSTALLER_URL');
const sha = arg('sha', 'PLACEHOLDER_SHA256').toUpperCase();
const MANIFEST_VERSION = '1.6.0';
// npm-style repository urls carry git+ / .git decorations; winget wants the plain page.
const homepage = String((pkg.repository && (pkg.repository.url || pkg.repository)) || 'https://github.com/Zbrooklyn/winmux')
  .replace(/^git\+/, '').replace(/\.git$/, '');
const desc = pkg.description || 'A terminal multiplexer and agent cockpit — desktop, browser, and phone over Tailscale.';
// Single-quote a YAML scalar so colons/dashes in free text never break the parse.
const yq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// A flat winget manifest is simple enough to emit without a YAML dependency.
const versionYaml = [
  '# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.' + MANIFEST_VERSION + '.schema.json',
  'PackageIdentifier: ' + identifier,
  'PackageVersion: ' + version,
  'DefaultLocale: en-US',
  'ManifestType: version',
  'ManifestVersion: ' + MANIFEST_VERSION,
  '',
].join('\n');

const installerYaml = [
  '# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.' + MANIFEST_VERSION + '.schema.json',
  'PackageIdentifier: ' + identifier,
  'PackageVersion: ' + version,
  'InstallerType: nullsoft',
  'Scope: user',
  'InstallModes:',
  '  - interactive',
  '  - silent',
  '  - silentWithProgress',
  'Installers:',
  '  - Architecture: x64',
  '    InstallerUrl: ' + url,
  '    InstallerSha256: ' + sha,
  'ManifestType: installer',
  'ManifestVersion: ' + MANIFEST_VERSION,
  '',
].join('\n');

const localeYaml = [
  '# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.' + MANIFEST_VERSION + '.schema.json',
  'PackageIdentifier: ' + identifier,
  'PackageVersion: ' + version,
  'PackageLocale: en-US',
  'Publisher: ' + publisherId,
  'PackageName: ' + packageName,
  'License: ' + (pkg.license || 'MIT'),
  'ShortDescription: ' + yq(desc),
  'PackageUrl: ' + homepage,
  'ManifestType: defaultLocale',
  'ManifestVersion: ' + MANIFEST_VERSION,
  '',
].join('\n');

const outDir = path.resolve(ROOT, arg('out', path.join('manifests', 'winget', version)));
fs.mkdirSync(outDir, { recursive: true });
const files = {
  [identifier + '.yaml']: versionYaml,
  [identifier + '.installer.yaml']: installerYaml,
  [identifier + '.locale.en-US.yaml']: localeYaml,
};
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), body);

const placeholder = url.startsWith('PLACEHOLDER') || sha.startsWith('PLACEHOLDER');
console.log('wrote winget manifests for ' + identifier + ' ' + version + ' → ' + outDir);
if (placeholder) console.log('NOTE: url/sha are placeholders — re-run with --url and --sha once the release is published.');
