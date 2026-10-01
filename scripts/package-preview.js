// Local preview builds carry the reviewed renderer instead of release content.
// They preserve the existing a0-launcher userData and must not run beside release.
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const packager = require('@electron/packager');

async function main() {
  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json');
  const semver = require('semver');
  const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const version = `${semver.coerce(pkg.version).version}-preview.${revision}`;
  const identity = process.env.A0_PREVIEW_SIGN_IDENTITY;
  const outputs = await packager({
    dir: root,
    out: path.join(root, 'dist', 'preview'),
    name: 'Agent Zero Launcher Preview',
    executableName: 'a0-launcher-preview',
    appBundleId: 'ai.agent0.launcher.preview',
    appVersion: version,
    platform: process.platform,
    arch: process.arch,
    overwrite: true,
    asar: true,
    icon: path.join(root, 'shell', 'assets', 'icon'),
    protocols: [{ name: 'Agent Zero computer setup', schemes: ['a0-launcher'] }],
    ignore: /^\/(?!app(?:\/|$)|shell(?:\/|$)|node_modules(?:\/|$)|package\.json$|package-lock\.json$)/,
    osxSign: process.platform === 'darwin' && identity ? {
      identity,
      hardenedRuntime: true,
      entitlements: path.join(root, 'shell', 'assets', 'entitlements.mac.plist'),
      'entitlements-inherit': path.join(root, 'shell', 'assets', 'entitlements.mac.plist'),
    } : undefined,
    afterCopy: [(buildPath, _version, _platform, _arch, done) => {
      (async () => {
        const target = path.join(buildPath, 'package.json');
        const metadata = JSON.parse(await fs.readFile(target, 'utf8'));
        metadata.version = version;
        metadata.a0BundledPreview = true;
        await fs.writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`);
      })().then(() => done(), done);
    }],
  });
  console.log(`Preview ${version}: ${outputs.join(', ')}`);
}

let completed = false;
process.once('beforeExit', () => {
  if (!completed) {
    console.error('Packaging did not finish. Use the project-compatible Node LTS runtime and retry.');
    process.exitCode = 1;
  }
});
main().then(() => { completed = true; }).catch((error) => {
  completed = true;
  console.error(error.message);
  process.exitCode = 1;
});
