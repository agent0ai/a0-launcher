const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const resolver = source.slice(source.indexOf('function resolveLocalRepoDir()'), source.indexOf('\nconst LOCAL_REPO_DIR'));
const updater = source.slice(source.indexOf('function shouldEnableLauncherAutoUpdate()'), source.indexOf('\nfunction loadLauncherAutoUpdater()'));
function context(preview, exists = true) {
  return vm.createContext({ BUNDLED_PREVIEW: preview, app: { isPackaged: true, getAppPath: () => '/installed/app.asar' },
    isLocalRepoContentDir: () => exists, process: { env: {}, cwd: () => '/unrelated' }, path,
    LOCAL_REPO_ENV_VAR: 'LOCAL', USE_LOCAL_CONTENT_ENV_VAR: 'LOCAL_CWD', isTruthyEnv: () => false,
    defaultAppRepoArg: () => '' });
}
test('packaged preview uses bundled content regardless of launch directory', () => {
  assert.equal(vm.runInContext(`${resolver}; resolveLocalRepoDir()`, context(true)), '/installed/app.asar');
});
test('broken preview fails instead of silently loading the released interface', () => {
  assert.throws(() => vm.runInContext(`${resolver}; resolveLocalRepoDir()`, context(true, false)), /missing its bundled interface/);
});
test('release builds retain remote content and updates; previews cannot self-replace', () => {
  assert.equal(vm.runInContext(`${resolver}; resolveLocalRepoDir()`, context(false)), '');
  assert.equal(vm.runInContext(`${updater}; shouldEnableLauncherAutoUpdate()`, context(false)), true);
  assert.equal(vm.runInContext(`${updater}; shouldEnableLauncherAutoUpdate()`, context(true)), false);
});
