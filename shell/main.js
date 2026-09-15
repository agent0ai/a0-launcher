const { app, BrowserWindow, WebContentsView, Menu, net, ipcMain, shell, nativeImage, protocol, dialog, systemPreferences, globalShortcut, screen, clipboard, Notification } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dockerManager = require('./docker_manager');
const developerProjects = require('./developer_projects');
const {
  normalizeInstanceColor,
  normalizeInstanceIcon,
  normalizeHttpUrl,
  instanceUiSectionUrl,
  instanceUiSectionScript,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  isAllowedInstanceTabNavigationUrl,
  makeTabKey,
  webUiLoginRequestForTarget,
  loginCredentialsFromRequest,
  instanceLoginRedirectSucceeded,
  credentialSavePromptDecision,
  instanceTabLoginRecoveryTarget,
  cliCredentialsAllowedForTarget,
  makeTabsSnapshot,
  reorderAttachedInstanceTabs,
  findInstanceTabByWebContents,
  instanceContextMenuActions,
  reloadInstanceWebContents,
  isInstanceTabReloadShortcut,
  instanceTabShortcutTarget,
  embeddedInstanceContentBounds,
  detachedInstanceContentBounds
} = require('./instance_tabs');
const { formatLauncherVersion } = require('./launcher_update');
const {
  hostAccessMatchesGateway,
  hostAccessInstanceKey,
  normalizeHostAccessSettings,
  resolveInstanceHostAccess
} = require('./host_access');
const {
  HostGatewaySupervisor,
  coreCapabilitiesSupportLauncher,
  gatewayHelpSupportsLauncher,
  gatewayHostUrl,
  launcherGatewayId,
  launcherUserAgent,
  publicGatewayStatus
} = require('./host_gateway');
const {
  ensureMacAccessibilityPermission,
  ensureMacMicrophonePermission,
  localizeMacPermissionStatus,
  macAccessibilityPermissionMessage,
  macMicrophonePermissionMessage
} = require('./macos_permissions');
const {
  A0_CLI_RELEASE_API_URL,
  normalizeA0CliVersion,
  runA0CliInstaller,
  runA0CliUpdate,
  shouldInstallA0Cli
} = require('./a0_cli_install');
const {
  cleanupLauncherUpdaterArtifacts,
  writeLauncherUpdaterInstallMarker
} = require('./launcher_updater_artifacts');
const { resolveLauncherUpdaterLogPath } = require('./launcher_updater_install_options');
const {
  resolveLauncherWindowsReleaseArchFallback,
  resolveLauncherDebugReleaseAssetUrl,
  resolveLauncherDebugReleaseTag,
  stageLauncherDebugRelease
} = require('./launcher_updater_debug_release');
const {
  A0TagController,
  A0TagOverlay,
  GnomeA0TagShortcut,
  a0TagLeaseReadiness,
  cancelA0TagMicrophone,
  getA0TagMicrophoneStatus,
  normalizeA0TagConfig,
  normalizeProfiles,
  runA0TagMicrophone
} = require('./a0_tag');

const OPEN_UI_READY_TIMEOUT_MS = 20_000;
const OPEN_UI_READY_INTERVAL_MS = 450;
const HOST_BROWSER_PREPARE_TIMEOUT_MS = 75_000;
const COMPUTER_USE_RESUME_ARG = '--a0-resume-computer-use=';
const MAC_ACCESSIBILITY_SETUP_TIMEOUT_MS = 115000;

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

// Handle Squirrel.Windows startup events
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Constants
const DEFAULT_GITHUB_REPO = 'agent0ai/a0-launcher';
const BUILD_INFO_FILE = path.join(__dirname, 'build-info.json');
const GITHUB_REPO_ENV_VAR = 'A0_LAUNCHER_GITHUB_REPO';
const LOCAL_REPO_ENV_VAR = 'A0_LAUNCHER_LOCAL_REPO';
const USE_LOCAL_CONTENT_ENV_VAR = 'A0_LAUNCHER_USE_LOCAL_CONTENT';
const PUBLIC_RESOURCE_LINKS = Object.freeze({
  docs: 'https://www.agent-zero.ai/p/docs/',
  apiDashboard: 'https://www.agent-zero.ai/p/community/api-dashboard/',
  support: 'https://discord.gg/8bz37YKSwT'
});
const developerProjectCleanupOwners = new Set();

function isTruthyEnv(value) {
  const v = (value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function normalizeGithubRepo(value) {
  const v = (value || '').trim();
  if (!v) return '';
  const cleaned = v.endsWith('.git') ? v.slice(0, -4) : v;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) return cleaned;

  // HTTPS GitHub URL (with optional credentials and optional .git suffix)
  const httpsMatch = cleaned.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];

  // SSH GitHub URL (git@github.com:owner/repo.git)
  const sshMatch = cleaned.match(/github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  return '';
}

function getGithubRepo() {
  const fromEnv = normalizeGithubRepo(process.env[GITHUB_REPO_ENV_VAR]);
  if (fromEnv) return fromEnv;

  try {
    const raw = fsSync.readFileSync(BUILD_INFO_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const fromFile = normalizeGithubRepo(parsed?.githubRepo);
    if (fromFile) return fromFile;
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_REPO;
}

function defaultAppRepoArg(argv = process.argv) {
  if (!process.defaultApp) return '';
  for (const rawArg of Array.isArray(argv) ? argv.slice(1) : []) {
    const arg = String(rawArg || '').trim();
    if (!arg || arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

function computerUseResumeIdentity(argv = process.argv) {
  const raw = (Array.isArray(argv) ? argv : [])
    .map((value) => String(value || ''))
    .find((value) => value.startsWith(COMPUTER_USE_RESUME_ARG));
  const identity = raw ? raw.slice(COMPUTER_USE_RESUME_ARG.length) : '';
  const match = identity.match(/^(local|remote):([A-Za-z0-9._:-]{1,256})$/);
  return match ? { kind: match[1], id: match[2] } : null;
}

function isLocalRepoContentDir(dir) {
  try {
    const appIndex = path.join(dir, 'app', 'index.html');
    const pkg = path.join(dir, 'package.json');
    return fsSync.existsSync(appIndex) && fsSync.existsSync(pkg);
  } catch {
    return false;
  }
}

function resolveLocalRepoDir() {
  const rawPath = (process.env[LOCAL_REPO_ENV_VAR] || '').trim();
  const useLocalFromCwd = isTruthyEnv(process.env[USE_LOCAL_CONTENT_ENV_VAR]);
  const defaultAppPath = defaultAppRepoArg();
  const useCwdFallback = useLocalFromCwd || process.defaultApp || !app.isPackaged;

  const candidates = [];
  if (rawPath) candidates.push(path.resolve(process.cwd(), rawPath));
  if (defaultAppPath) candidates.push(path.resolve(process.cwd(), defaultAppPath));
  if (useCwdFallback) candidates.push(process.cwd());

  for (const dir of candidates) {
    if (isLocalRepoContentDir(dir)) {
      return dir;
    }
  }

  return '';
}

const LOCAL_REPO_DIR = resolveLocalRepoDir();
const USING_LOCAL_CONTENT = !!LOCAL_REPO_DIR;
let pendingComputerUseResume = computerUseResumeIdentity();
const LOCAL_INDEX_FILE = USING_LOCAL_CONTENT ? path.join(LOCAL_REPO_DIR, 'app', 'index.html') : '';

const GITHUB_REPO = getGithubRepo();
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CONTENT_ASSET_NAME = 'content.json';
const SPLASH_ENTRY_ANIMATION_MS = 600;
const SPLASH_EXIT_ANIMATION_MS = 120;

if (USING_LOCAL_CONTENT) {
  console.log(`Using local dev content: ${LOCAL_INDEX_FILE}`);
} else {
  console.log(`Using GitHub content repo: ${GITHUB_REPO}`);
}

// Paths
const USER_DATA_DIR = app.getPath('userData');
const CONTENT_DIR = path.join(USER_DATA_DIR, 'app_content');
const META_FILE = path.join(USER_DATA_DIR, 'content_meta.json');
const CONTENT_STAGING_PREFIX = 'app_content_pending-';
const CONTENT_BACKUP_PREFIX = 'app_content_previous-';
const CONTENT_REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 150 };
const CONTENT_SWAP_MAX_RETRIES = 8;
const CONTENT_SWAP_RETRY_DELAY_MS = 150;

let mainWindow;
let contentInitialized = false;
let instanceTabs = new Map();
let activeInstanceTabId = '';
let instanceTabBounds = null;
let instanceTabSeq = 0;
const observedInstanceLoginSessions = new WeakSet();
let launcherUpdateDismissed = false;
let launcherAutoUpdater = null;
let launcherUpdateCheckPromise = null;
let launcherUpdateDownloadPromise = null;
let launcherUpdateState = {
  state: 'idle',
  message: '',
  progress: null,
  version: ''
};
let mainWindowMode = '';
let mainWindowCreatedAt = 0;
let hostGatewayQuitPending = false;
let a0CliEnsurePromise = null;
let a0CliEnsureState = 'idle';
let a0CliResolvedBinary = '';
const pendingComputerUseSetup = new Set();
let a0TagController = null;
let gnomeA0TagShortcut = null;
let a0TagRuntime = {
  shortcut: 'CommandOrControl+Shift+Enter',
  status: 'disabled',
  message: 'Disabled',
  profiles: [],
  running: false
};

const hostGatewaySupervisor = new HostGatewaySupervisor({
  onStatus(leaseKey, status) {
    const tab = instanceTabForGatewayLease(leaseKey);
    if (!tab) return;
    const displayStatus = process.platform === 'darwin'
      ? localizeMacPermissionStatus(status, { isPackaged: app.isPackaged })
      : status;
    tab.hostAccess = {
      ...(tab.hostAccess || {}),
      ...displayStatus,
      config: tab.hostAccessConfig || null
    };
    sendInstanceTabsEvent();
    void maybeStartComputerUseSetup(tab, displayStatus);
  },
  onConfig(leaseKey, gateway) {
    void persistGatewayConfigForTab(leaseKey, gateway);
  }
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch the latest release info from GitHub
 */
async function fetchLatestRelease() {
  try {
    const response = await net.fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'A0-Launcher'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch latest release:', error);
    return null;
  }
}

/**
 * Read local content metadata
 */
async function readLocalMeta() {
  try {
    const data = await fs.readFile(META_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No local meta file found, will download content');
    } else {
      console.error('Error reading meta file:', error);
    }
    return null;
  }
}

/**
 * Write local content metadata
 */
async function writeLocalMeta(data) {
  await fs.writeFile(META_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parseTimestamp(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getLocalContentTimestamp(localMeta) {
  if (localMeta?.version === 'dev-local') {
    console.log('Ignoring legacy dev-local content metadata for release updates');
    return 0;
  }

  return parseTimestamp(localMeta?.published_at);
}

function getRemoteContentTimestamp(latestRelease, contentAsset) {
  return Math.max(
    parseTimestamp(latestRelease?.published_at),
    parseTimestamp(contentAsset?.updated_at)
  );
}

function isLauncherUpdateActionable(state = launcherUpdateState.state) {
  return ['update-available', 'downloading', 'downloaded', 'installing'].includes(state);
}

function publishLauncherUpdateState(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const payload = {
    ...launcherUpdateState,
    readyToContinue: contentInitialized,
    ...extra
  };

  mainWindow.webContents.send('launcher-update-status', payload);
  if (isLauncherUpdateActionable(payload.state)) {
    mainWindow.webContents.send('launcher-update-available', payload);
  }
}

function setLauncherUpdateState(patch = {}) {
  launcherUpdateState = {
    ...launcherUpdateState,
    ...patch
  };

  if (!Object.prototype.hasOwnProperty.call(patch, 'progress')) {
    launcherUpdateState.progress = null;
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'version')) {
    launcherUpdateState.version = launcherUpdateState.version || '';
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'message')) {
    launcherUpdateState.message = launcherUpdateState.message || '';
  }

  publishLauncherUpdateState();
}

function shouldEnableLauncherAutoUpdate() {
  return app.isPackaged;
}

function loadLauncherAutoUpdater() {
  if (launcherAutoUpdater) return launcherAutoUpdater;

  try {
    ({ autoUpdater: launcherAutoUpdater } = require('electron-updater'));
  } catch (error) {
    console.warn('[launcher-update] electron-updater is unavailable.', error);
    launcherAutoUpdater = null;
  }

  return launcherAutoUpdater;
}

async function appendLauncherUpdaterPersistentLog(logPath, message, details = null) {
  const resolvedLogPath = String(logPath || '').trim();
  const normalizedMessage = String(message || '').trim();
  if (!resolvedLogPath || !normalizedMessage) return;

  const lines = [
    `${new Date().toISOString()} [a0-launcher/updater] ${normalizedMessage}`
  ];

  if (details && typeof details === 'object') {
    try {
      lines.push(JSON.stringify(details));
    } catch {
      // Best-effort diagnostics only.
    }
  }

  try {
    await fs.mkdir(path.dirname(resolvedLogPath), { recursive: true });
    await fs.appendFile(resolvedLogPath, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // Persistent updater logging must never block launch or install handoff.
  }
}

function resolveLauncherUpdaterLogPathForCurrentRun() {
  return resolveLauncherUpdaterLogPath({
    userDataPath: app.getPath('userData')
  });
}

function isLauncherNetworkOnline() {
  try {
    return !net || typeof net.isOnline !== 'function' || net.isOnline();
  } catch {
    return true;
  }
}

function formatLauncherUpdateError(context, error) {
  const detail = error && typeof error.message === 'string' ? error.message : String(error || 'Unknown error');
  return `${context} ${detail}`;
}

function reportLauncherUpdateFailure(context, error) {
  const message = formatLauncherUpdateError(context, error);
  console.warn('[launcher-update]', message);
  setLauncherUpdateState({
    state: 'error',
    message,
    progress: null,
    version: ''
  });
  return { summary: message };
}

function resolveLauncherDebugReinstallRequestVersion(payload = {}) {
  if (typeof payload === 'string') {
    return payload.trim();
  }

  if (payload && typeof payload === 'object') {
    return String(payload.version || '').trim();
  }

  return '';
}

async function fetchLauncherUpdateMetadataText(metadataUrl) {
  const response = await net.fetch(metadataUrl, {
    headers: {
      accept: 'text/yaml, text/x-yaml, text/plain, */*'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Could not download launcher update metadata ${metadataUrl} (${response.status} ${response.statusText || 'Unknown'}).`
    );
  }

  return await response.text();
}

async function downloadLauncherUpdateAssetToFile(assetUrl, destinationPath, { onProgress } = {}) {
  const response = await net.fetch(assetUrl, {
    headers: {
      accept: 'application/octet-stream, */*'
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download launcher update asset ${assetUrl} (${response.status} ${response.statusText || 'Unknown'}).`
    );
  }

  const totalBytes = Number(response.headers.get('content-length')) || 0;
  const destinationDir = path.dirname(destinationPath);
  const temporaryPath = path.join(destinationDir, `temp-${path.basename(destinationPath)}`);
  const hash = createHash('sha512');
  let downloadedBytes = 0;

  await fs.mkdir(destinationDir, { recursive: true });
  await fs.rm(temporaryPath, { force: true });
  await fs.rm(destinationPath, { force: true });

  const hashAndProgress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloadedBytes += chunk.length;
      onProgress?.({
        downloadedBytes,
        totalBytes,
        progress: totalBytes > 0 ? downloadedBytes / totalBytes : null
      });
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), hashAndProgress, fsSync.createWriteStream(temporaryPath));
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    sha512: hash.digest('base64'),
    size: downloadedBytes
  };
}

async function downloadLauncherWindowsUpdateWithArchFallback(autoUpdater) {
  if (process.platform !== 'win32') return null;

  const updateInfoAndProvider = autoUpdater?.updateInfoAndProvider;
  const updateInfo = updateInfoAndProvider?.info || null;
  const fallback = resolveLauncherWindowsReleaseArchFallback(updateInfo, process.arch);
  if (!fallback) return null;

  const publishConfig = await autoUpdater.configOnDisk.value;
  const tag = resolveLauncherDebugReleaseTag(updateInfo?.version || '');
  const installerUrl = resolveLauncherDebugReleaseAssetUrl({
    publishConfig,
    tag,
    fileName: fallback.expectedFileName
  });
  const downloadedUpdateHelper = await autoUpdater.getOrCreateDownloadHelper();
  const pendingDir = downloadedUpdateHelper.cacheDirForPendingUpdate;
  const destinationPath = path.join(pendingDir, fallback.expectedFileName);
  const logPath = resolveLauncherUpdaterLogPathForCurrentRun();

  await appendLauncherUpdaterPersistentLog(logPath, 'Windows update metadata is missing the current arch installer; using the canonical release asset fallback.', {
    actualFiles: fallback.actualFiles,
    currentArch: process.arch,
    expectedArch: fallback.expectedArch,
    expectedFileName: fallback.expectedFileName,
    installerUrl,
    targetVersion: updateInfo?.version || ''
  });

  await downloadedUpdateHelper.clear();

  setLauncherUpdateState({
    state: 'downloading',
    message: 'Downloading update...',
    progress: null,
    version: formatLauncherVersion(updateInfo?.version || '')
  });

  const downloadedFile = await downloadLauncherUpdateAssetToFile(installerUrl, destinationPath, {
    onProgress({ progress }) {
      if (!Number.isFinite(progress)) return;
      const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
      setLauncherUpdateState({
        state: 'downloading',
        message: `Downloading update ${percent}%`,
        progress,
        version: formatLauncherVersion(updateInfo?.version || '')
      });
    }
  });

  const fileInfo = {
    url: new URL(installerUrl),
    info: {
      url: fallback.expectedFileName,
      sha512: downloadedFile.sha512,
      size: String(downloadedFile.size)
    }
  };
  const normalizedUpdateInfo = {
    ...updateInfo,
    files: [fileInfo.info],
    path: fallback.expectedFileName,
    sha512: downloadedFile.sha512
  };

  await downloadedUpdateHelper.setDownloadedFile(
    destinationPath,
    null,
    normalizedUpdateInfo,
    fileInfo,
    fallback.expectedFileName,
    true
  );
  autoUpdater.updateInfoAndProvider = {
    info: normalizedUpdateInfo,
    provider: updateInfoAndProvider.provider
  };

  const version = formatLauncherVersion(normalizedUpdateInfo.version);
  setLauncherUpdateState({
    state: 'downloaded',
    message: version ? `Update ${version} is ready to install.` : 'Update ready to install.',
    progress: null,
    version
  });

  return {
    ok: true,
    status: 'downloaded',
    version
  };
}

async function checkForLauncherUpdates({ userInitiated = false } = {}) {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (launcherUpdateCheckPromise) {
    return launcherUpdateCheckPromise;
  }

  if (!isLauncherNetworkOnline()) {
    const message = 'Update check skipped while offline.';
    setLauncherUpdateState({
      state: 'offline',
      message,
      progress: null,
      version: ''
    });
    return { ok: false, reason: 'offline', message };
  }

  launcherUpdateCheckPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = formatLauncherVersion(result?.updateInfo?.version);
      return {
        ok: true,
        status: launcherUpdateState.state || 'checked',
        version
      };
    } catch (error) {
      const formattedError = reportLauncherUpdateFailure(
        userInitiated ? 'Launcher update check failed.' : 'Launcher auto-update check failed.',
        error
      );
      return {
        ok: false,
        reason: 'error',
        message: formattedError.summary
      };
    } finally {
      launcherUpdateCheckPromise = null;
    }
  })();

  return launcherUpdateCheckPromise;
}

async function downloadLauncherUpdate() {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (launcherUpdateState.state === 'downloaded') {
    return { ok: true, status: 'downloaded', version: launcherUpdateState.version || '' };
  }

  if (launcherUpdateDownloadPromise) {
    return launcherUpdateDownloadPromise;
  }

  if (launcherUpdateState.state !== 'update-available') {
    return { ok: false, reason: 'not-ready', message: 'No launcher update is ready to download yet.' };
  }

  launcherUpdateDownloadPromise = (async () => {
    try {
      const windowsArchFallbackResult = await downloadLauncherWindowsUpdateWithArchFallback(autoUpdater);
      if (windowsArchFallbackResult) {
        return windowsArchFallbackResult;
      }

      await autoUpdater.downloadUpdate();
      return {
        ok: true,
        status: 'downloading',
        version: launcherUpdateState.version || ''
      };
    } catch (error) {
      const formattedError = reportLauncherUpdateFailure('Launcher update download failed.', error);
      return {
        ok: false,
        reason: 'error',
        message: formattedError.summary
      };
    } finally {
      launcherUpdateDownloadPromise = null;
    }
  })();

  return launcherUpdateDownloadPromise;
}

async function installLauncherUpdate() {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (launcherUpdateState.state !== 'downloaded') {
    return { ok: false, reason: 'not-ready', message: 'No downloaded launcher update is ready to install yet.' };
  }

  setLauncherUpdateState({
    state: 'installing',
    message: 'Updating A0 CLI...',
    progress: null
  });

  const logPath = resolveLauncherUpdaterLogPathForCurrentRun();
  const useSilentWindowsInstall = process.platform === 'win32';

  try {
    hostGatewaySupervisor.stopAll('cli_update', { preserveSuppression: true });
    if (hostGatewaySupervisor.pendingStopCount()) {
      await hostGatewaySupervisor.waitForStopped(8500);
    }
    const cli = await ensureA0CliInstalled();
    await runA0CliUpdate(cli);
    await appendLauncherUpdaterPersistentLog(logPath, 'A0 CLI update command completed.');
  } catch (error) {
    console.warn('[launcher-update] A0 CLI update failed; continuing with the Launcher update.', error);
    await appendLauncherUpdaterPersistentLog(logPath, 'A0 CLI update command failed.', {
      message: error && typeof error.message === 'string' ? error.message : String(error || 'Unknown error')
    });
  }

  setLauncherUpdateState({
    state: 'installing',
    message: 'Restarting to install update...',
    progress: null
  });

  try {
    await writeLauncherUpdaterInstallMarker({
      fromVersion: app.getVersion(),
      targetVersion: launcherUpdateState.version || '',
      userDataPath: app.getPath('userData')
    });
    await appendLauncherUpdaterPersistentLog(logPath, 'Updater cleanup marker written.', {
      fromVersion: app.getVersion(),
      targetVersion: launcherUpdateState.version || ''
    });
  } catch (error) {
    await appendLauncherUpdaterPersistentLog(logPath, 'Could not persist the updater cleanup marker.', {
      message: error && typeof error.message === 'string' ? error.message : String(error || 'Unknown error')
    });
  }

  await appendLauncherUpdaterPersistentLog(logPath, 'Installing downloaded launcher update with electron-updater.', {
    installerPath: autoUpdater?.installerPath || '',
    isForceRunAfter: useSilentWindowsInstall,
    isSilent: useSilentWindowsInstall,
    packagePath: autoUpdater?.downloadedUpdateHelper?.packageFile || '',
    targetVersion: launcherUpdateState.version || ''
  });

  setImmediate(() => {
    autoUpdater.quitAndInstall(useSilentWindowsInstall, useSilentWindowsInstall);
  });

  return { ok: true, status: 'installing', version: launcherUpdateState.version || '' };
}

async function beginLauncherUpdate() {
  if (launcherUpdateState.state === 'downloaded') {
    return installLauncherUpdate();
  }

  if (launcherUpdateState.state === 'update-available') {
    return downloadLauncherUpdate();
  }

  if (launcherUpdateState.state === 'downloading' || launcherUpdateState.state === 'installing') {
    return { ok: true, status: launcherUpdateState.state, version: launcherUpdateState.version || '' };
  }

  const checkResult = await checkForLauncherUpdates({ userInitiated: true });
  if (launcherUpdateState.state === 'update-available') {
    return downloadLauncherUpdate();
  }
  return checkResult;
}

async function stageLauncherDebugReinstall(payload = {}) {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (!isLauncherNetworkOnline()) {
    const message = 'Debug reinstall skipped while offline.';
    setLauncherUpdateState({
      state: 'offline',
      message,
      progress: null,
      version: ''
    });
    return { ok: false, reason: 'offline', message };
  }

  const requestedVersion = resolveLauncherDebugReinstallRequestVersion(payload);
  const currentVersion = app.getVersion();
  const requestedLabel = requestedVersion || currentVersion;

  setLauncherUpdateState({
    state: 'checking',
    message: 'Preparing debug reinstall...',
    progress: null,
    version: ''
  });

  try {
    const publishConfig = await autoUpdater.configOnDisk.value;
    const stagedRelease = await stageLauncherDebugRelease({
      requestedVersion,
      currentVersion,
      platform: process.platform,
      arch: process.arch,
      publishConfig,
      fetchText: fetchLauncherUpdateMetadataText
    });
    const targetVersion = formatLauncherVersion(stagedRelease.info?.version || stagedRelease.requestedVersion);
    const action =
      stagedRelease.comparison < 0
        ? 'downgrade'
        : stagedRelease.comparison === 0
          ? 'reinstall'
          : 'update';
    const logPath = resolveLauncherUpdaterLogPathForCurrentRun();

    autoUpdater.allowDowngrade = stagedRelease.comparison < 0;
    autoUpdater.updateInfoAndProvider = {
      info: stagedRelease.info,
      provider: stagedRelease.provider
    };

    await appendLauncherUpdaterPersistentLog(logPath, 'Prepared launcher debug reinstall staging.', {
      action,
      currentVersion,
      metadataFileName: stagedRelease.metadataFileName,
      metadataUrl: stagedRelease.metadataUrl,
      requestedVersion: requestedLabel,
      targetVersion: stagedRelease.info?.version || stagedRelease.requestedVersion,
      tag: stagedRelease.tag
    });

    setLauncherUpdateState({
      state: 'update-available',
      message: targetVersion ? `Update ${targetVersion} is available.` : 'A launcher update is available.',
      progress: null,
      version: targetVersion
    });

    const downloadResult = await downloadLauncherUpdate();
    if (!downloadResult?.ok) {
      return downloadResult;
    }

    return {
      ok: true,
      action,
      metadataUrl: stagedRelease.metadataUrl,
      status: launcherUpdateState.state,
      tag: stagedRelease.tag,
      version: launcherUpdateState.version || targetVersion
    };
  } catch (error) {
    const formattedError = reportLauncherUpdateFailure(
      `Launcher debug reinstall preparation failed for ${requestedLabel}.`,
      error
    );
    return {
      ok: false,
      reason: 'error',
      message: formattedError.summary
    };
  }
}

function configureLauncherAutoUpdate() {
  if (!shouldEnableLauncherAutoUpdate()) {
    return;
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => {
    setLauncherUpdateState({
      state: 'checking',
      message: 'Checking for updates...',
      progress: null,
      version: ''
    });
  });

  autoUpdater.on('update-available', (info) => {
    const version = formatLauncherVersion(info?.version);
    setLauncherUpdateState({
      state: 'update-available',
      message: version ? `Update ${version} is available.` : 'A launcher update is available.',
      progress: null,
      version
    });
    console.log(version ? `Launcher update available: ${version}` : 'Launcher update available.');
  });

  autoUpdater.on('update-not-available', () => {
    setLauncherUpdateState({
      state: 'up-to-date',
      message: '',
      progress: null,
      version: ''
    });
  });

  autoUpdater.on('error', (error) => {
    reportLauncherUpdateFailure('Launcher auto-update failed.', error);
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress && progress.percent);
    if (!Number.isFinite(percent)) {
      setLauncherUpdateState({
        state: 'downloading',
        message: 'Downloading update...',
        progress: null
      });
      return;
    }

    const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    setLauncherUpdateState({
      state: 'downloading',
      message: `Downloading update ${boundedPercent}%`,
      progress: boundedPercent / 100
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = formatLauncherVersion(info?.version);
    setLauncherUpdateState({
      state: 'downloaded',
      message: version ? `Update ${version} is ready to install.` : 'Update ready to install.',
      progress: null,
      version
    });
  });
}

async function cleanupStaleLauncherUpdaterArtifacts() {
  try {
    const result = await cleanupLauncherUpdaterArtifacts({
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData')
    });
    if (result.cleaned) {
      console.log('[launcher-update] Cleaned stale updater artifacts.');
    }
  } catch (error) {
    console.warn('[launcher-update] Could not clean stale updater artifacts.', error);
  }
}

function shouldHoldStartupForLauncherUpdate() {
  if (launcherUpdateDismissed || !isLauncherUpdateActionable()) {
    return false;
  }

  publishLauncherUpdateState({ readyToContinue: contentInitialized });
  if (launcherUpdateState.message) {
    sendStatus(launcherUpdateState.message);
  } else if (launcherUpdateState.version) {
    sendStatus(`Launcher ${launcherUpdateState.version} is available.`);
  } else {
    sendStatus('A launcher update is available.');
  }
  return true;
}

function resolveContentBundlePath(filePath, contentRootDir = CONTENT_DIR) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    throw new Error(`Invalid bundled content path: ${filePath}`);
  }

  if (path.isAbsolute(filePath) || path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Unsafe bundled content path: ${filePath}`);
  }

  const contentRoot = path.resolve(contentRootDir);
  const fullPath = path.resolve(contentRoot, filePath);
  if (fullPath === contentRoot || !fullPath.startsWith(contentRoot + path.sep)) {
    throw new Error(`Unsafe bundled content path: ${filePath}`);
  }

  return fullPath;
}

function decodeContentBundleEntry(filePath, entry) {
  if (typeof entry === 'string') {
    return { data: entry, options: 'utf8' };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Invalid bundled content entry: ${filePath}`);
  }

  const { encoding, data } = entry;
  if (typeof data !== 'string') {
    throw new Error(`Invalid bundled content data: ${filePath}`);
  }

  if (encoding === 'utf8') {
    return { data, options: 'utf8' };
  }

  if (encoding === 'base64') {
    return { data: Buffer.from(data, 'base64') };
  }

  throw new Error(`Unsupported bundled content encoding "${encoding}" for ${filePath}`);
}

function assertValidContentBundle(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') {
    throw new Error('Invalid content bundle');
  }

  if (!contentJson.files || typeof contentJson.files !== 'object' || Array.isArray(contentJson.files)) {
    throw new Error('Invalid content bundle files');
  }
}

async function removeContentPath(targetPath, options = {}) {
  const quiet = !!options.quiet;
  try {
    await fs.rm(targetPath, CONTENT_REMOVE_OPTIONS);
    return true;
  } catch (error) {
    if (!quiet) {
      throw error;
    }
    console.warn(`[content] Could not remove stale path ${targetPath}:`, error);
    return false;
  }
}

function isRetriableContentFsError(error) {
  return ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
}

async function renameContentPath(sourcePath, targetPath, options = {}) {
  const allowMissing = !!options.allowMissing;

  for (let attempt = 0; attempt <= CONTENT_SWAP_MAX_RETRIES; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath);
      return true;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') {
        return false;
      }

      if (error.code === 'ENOENT' || attempt >= CONTENT_SWAP_MAX_RETRIES || !isRetriableContentFsError(error)) {
        throw error;
      }

      await wait(CONTENT_SWAP_RETRY_DELAY_MS);
    }
  }

  return false;
}

async function cleanupStaleContentSwapDirs() {
  let entries = [];
  try {
    entries = await fs.readdir(USER_DATA_DIR, { withFileTypes: true });
  } catch (error) {
    console.warn('[content] Could not inspect stale content swap directories.', error);
    return;
  }

  await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .filter(entry => entry.name.startsWith(CONTENT_STAGING_PREFIX) || entry.name.startsWith(CONTENT_BACKUP_PREFIX))
    .map(entry => removeContentPath(path.join(USER_DATA_DIR, entry.name), { quiet: true })));
}

function createContentSwapDir(prefix) {
  return path.join(USER_DATA_DIR, `${prefix}${Date.now()}-${process.pid}`);
}

async function unpackContentBundle(contentJson, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });

  for (const [filePath, entry] of Object.entries(contentJson.files)) {
    const fullPath = resolveContentBundlePath(filePath, targetDir);
    const dir = path.dirname(fullPath);
    const { data, options } = decodeContentBundleEntry(filePath, entry);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, data, options);
  }
}

async function replaceContentDirectory(stagingDir) {
  const backupDir = createContentSwapDir(CONTENT_BACKUP_PREFIX);
  const backupCreated = await renameContentPath(CONTENT_DIR, backupDir, { allowMissing: true });

  try {
    await renameContentPath(stagingDir, CONTENT_DIR);
  } catch (error) {
    if (backupCreated) {
      try {
        await renameContentPath(backupDir, CONTENT_DIR);
      } catch (restoreError) {
        console.error('[content] Could not restore previous content after failed swap.', restoreError);
      }
    }
    throw error;
  }

  if (backupCreated) {
    await removeContentPath(backupDir, { quiet: true });
  }
}

/**
 * Download and extract content from the release asset
 */
async function downloadContent(downloadUrl) {
  sendStatus('Downloading latest content...');

  const response = await net.fetch(downloadUrl, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'A0-Launcher'
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const contentJson = await response.json();
  assertValidContentBundle(contentJson);

  await cleanupStaleContentSwapDirs();

  const stagingDir = createContentSwapDir(CONTENT_STAGING_PREFIX);

  // Write the full bundle before replacing the live content directory.
  sendStatus('Extracting content...');

  try {
    await unpackContentBundle(contentJson, stagingDir);
    await replaceContentDirectory(stagingDir);
  } catch (error) {
    await removeContentPath(stagingDir, { quiet: true });
    throw error;
  }

  console.log(`Extracted ${Object.keys(contentJson.files).length} files`);
}

/**
 * Send status update to renderer
 */
function sendStatus(message) {
  console.log('Status:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', message);
  }
}

/**
 * Send error to renderer
 */
function sendError(message) {
  console.error('Error:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-error', message);
  }
}

/**
 * Initialize app content - check for updates and download if needed
 */
async function initializeAppContent() {
  if (USING_LOCAL_CONTENT) {
    sendStatus('Using local dev content');
    return true;
  }

  sendStatus('Checking for updates...');

  const latestRelease = await fetchLatestRelease();

  if (!latestRelease) {
    // Offline or API error - try to use existing content
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      sendError('Unable to fetch updates and no local content available. Please check your internet connection.');
      return false;
    }
    sendStatus('Using cached content (offline mode)');
    return true;
  }

  const contentAsset = latestRelease.assets?.find(
    asset => asset.name === CONTENT_ASSET_NAME
  );

  if (!contentAsset) {
    console.error(`No ${CONTENT_ASSET_NAME} asset found in release`);
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      sendError('Release does not contain required content bundle.');
      return false;
    }
    return true;
  }

  const localMeta = await readLocalMeta();
  const remoteTimestamp = getRemoteContentTimestamp(latestRelease, contentAsset);
  const localTimestamp = getLocalContentTimestamp(localMeta);

  if (remoteTimestamp > localTimestamp) {
    const remotePublishedAt = new Date(remoteTimestamp).toISOString();
    console.log(`Update available: ${latestRelease.tag_name} (${remotePublishedAt})`);

    try {
      await downloadContent(contentAsset.browser_download_url);

      // Save metadata
      await writeLocalMeta({
        version: latestRelease.tag_name,
        published_at: remotePublishedAt,
        release_published_at: latestRelease.published_at,
        asset_updated_at: contentAsset.updated_at,
        downloaded_at: new Date().toISOString()
      });

      sendStatus('Update complete!');
    } catch (error) {
      console.error('Download failed:', error);
      const hasContent = await checkExistingContent();
      if (!hasContent) {
        sendError(`Download failed: ${error.message}`);
        return false;
      }
      sendStatus('Using cached content (download failed)');
    }
  } else {
    console.log('Content is up to date');
    sendStatus('Content is up to date');
  }

  return true;
}

/**
 * Check if existing content is available
 */
async function checkExistingContent() {
  try {
    const indexPath = USING_LOCAL_CONTENT ? LOCAL_INDEX_FILE : path.join(CONTENT_DIR, 'index.html');
    if (!indexPath) return false;
    await fs.access(indexPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the app content into the window.
 * Uses the a0app:// custom protocol so that fetch(), URL resolution, and
 * ES module imports inside the content work exactly like a real web server.
 */
async function loadAppContent() {
  const indexPath = USING_LOCAL_CONTENT ? LOCAL_INDEX_FILE : path.join(CONTENT_DIR, 'index.html');

  try {
    await fs.access(indexPath);
    await ensureAppWindowForContent();
    mainWindow.loadURL('a0app://content/index.html');
  } catch {
    // Fallback: show error in loading page
    if (USING_LOCAL_CONTENT) {
      sendError(`Local content not found at ${indexPath}`);
    } else {
      sendError('No content available. Please ensure a release exists with content.json.');
    }
  }
}

async function continueToAppContent() {
  if (mainWindowMode === 'splash') {
    const remainingEntryMs = SPLASH_ENTRY_ANIMATION_MS - Math.max(0, Date.now() - mainWindowCreatedAt);
    if (remainingEntryMs > 0) await wait(remainingEntryMs);
  }
  await loadAppContent();
  void a0TagController?.sync?.().catch?.(() => {});
  scheduleRuntimeSetupResume();
  scheduleComputerUseSetupResume();
}

/**
 * Create the main browser window
 */
function attachWindowDiagnostics(windowRef) {
  windowRef.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
  });
  windowRef.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer-error] ${message}`);
  });
}

function createWindow(mode = 'splash') {
  const iconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );
  const isSplash = mode === 'splash';

  const windowRef = new BrowserWindow({
    width: isSplash ? 360 : 1280,
    height: isSplash ? 300 : 800,
    minWidth: isSplash ? 360 : 800,
    minHeight: isSplash ? 300 : 600,
    title: 'Agent Zero Launcher',
    icon: iconPath,
    show: false,
    frame: !isSplash,
    transparent: isSplash,
    resizable: !isSplash,
    maximizable: !isSplash,
    fullscreenable: !isSplash,
    hasShadow: !isSplash,
    backgroundColor: isSplash ? '#00000000' : '#131313',
    skipTaskbar: isSplash,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = windowRef;
  mainWindowMode = mode;
  mainWindowCreatedAt = Date.now();
  attachWindowDiagnostics(windowRef);
  if (!isSplash) windowRef.on('resize', applyActiveInstanceTabBounds);

  const loadPromise = isSplash
    ? windowRef.loadFile(path.join(__dirname, 'loading.html')).catch((error) => {
        console.error('[startup] Could not load the splash window.', error);
      })
    : Promise.resolve();

  windowRef.once('ready-to-show', () => {
    if (!windowRef.isDestroyed()) windowRef.show();
  });

  windowRef.on('closed', () => {
    if (mainWindow === windowRef) {
      if (!isSplash) {
        cleanupInstanceTabs();
        a0TagController?.dispose?.();
      }
      mainWindow = null;
      mainWindowMode = '';
    }
  });
  return loadPromise;
}

async function playSplashExitAnimation(splashWindow) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    splashWindow.webContents.send('launcher-opening-app');
  } catch {
    return;
  }
  await wait(SPLASH_EXIT_ANIMATION_MS);
}

async function ensureAppWindowForContent() {
  if (mainWindowMode !== 'splash') return;

  const splashWindow = mainWindow;
  await playSplashExitAnimation(splashWindow);
  createWindow('app');

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
}

// IPC Handlers
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-content-version', async () => {
  if (USING_LOCAL_CONTENT) return 'dev-local';

  try {
    const meta = await readLocalMeta();
    return meta?.version || 'unknown';
  } catch {
    return 'unknown';
  }
});

ipcMain.handle('get-shell-icon-data-url', () => {
  try {
    const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    const image = nativeImage.createFromPath(iconPath);
    if (!image || image.isEmpty()) return '';
    return image.resize({ width: 32, height: 32 }).toDataURL();
  } catch {
    return '';
  }
});

ipcMain.handle('check-launcher-update', () => checkForLauncherUpdates({ userInitiated: true }));
ipcMain.handle('begin-launcher-update', () => beginLauncherUpdate());
ipcMain.handle('download-launcher-update', () => downloadLauncherUpdate());
ipcMain.handle('install-launcher-update', () => installLauncherUpdate());
ipcMain.handle('launcher-debug-reinstall', (_event, payload) => stageLauncherDebugReinstall(payload));

ipcMain.handle('continue-after-launcher-update', async () => {
  try {
    launcherUpdateDismissed = true;
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      return { ok: false, reason: 'no-content', message: 'No launcher content is available yet.' };
    }
    await continueToAppContent();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error && typeof error.message === 'string' ? error.message : 'Could not continue.'
    };
  }
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedLocalUrl(value) {
  return isAllowedLocalInstanceUrl(value);
}

function isAllowedHttpUrl(value) {
  return isAllowedRemoteInstanceUrl(value);
}

function getPublicResourceUrl(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  const url = PUBLIC_RESOURCE_LINKS[key] || '';
  return normalizeHttpUrl(url);
}

async function openPublicResourceLink(id) {
  const url = getPublicResourceUrl(id);
  if (!url) {
    const error = new Error('Unknown Agent Zero resource link.');
    error.code = 'INVALID_RESOURCE_LINK';
    throw error;
  }
  await shell.openExternal(url);
  return { opened: true };
}

function tagLauncherWebContents(webContents) {
  if (!webContents || typeof webContents.getUserAgent !== 'function' || typeof webContents.setUserAgent !== 'function') {
    return;
  }
  const current = String(webContents.getUserAgent() || '').trim();
  webContents.setUserAgent(launcherUserAgent(current, app.getVersion()));
}

function hostAccessIdentity(tab) {
  if (tab?.kind === 'remote') {
    const id = String(tab.instanceId || '').trim();
    return id ? { kind: 'remote', id } : null;
  }
  const id = String(tab?.containerId || '').trim();
  return id ? { kind: 'local', id } : null;
}

function hostGatewayLeaseKey(tab) {
  const identity = hostAccessIdentity(tab);
  return identity ? `${identity.kind}:${identity.id}` : String(tab?.key || tab?.id || '');
}

function instanceTabForGatewayLease(leaseKey) {
  const key = String(leaseKey || '');
  for (const tab of instanceTabs.values()) {
    if (hostGatewayLeaseKey(tab) === key) return tab;
  }
  return null;
}

function hostAccessStatus(state, options = {}) {
  return publicGatewayStatus({
    state,
    hostLabel: options.hostLabel || os.hostname(),
    message: options.message || '',
    code: options.code || '',
    retryable: options.retryable === true,
    suppressed: options.suppressed === true
  });
}

function setTabHostAccess(tab, status, config = tab?.hostAccessConfig || null) {
  if (!tab || !instanceTabs.has(tab.id)) return;
  tab.hostAccessConfig = config;
  tab.hostAccess = {
    ...status,
    config
  };
  sendInstanceTabsEvent();
}

function publicHostAccessSettings(value) {
  const settings = normalizeHostAccessSettings(value);
  return {
    version: 1,
    onboardingComplete: settings.onboardingComplete,
    defaults: settings.defaults,
    instances: settings.instances
  };
}

function publicA0TagState(value) {
  const runtime = a0TagController?.snapshot?.() || a0TagRuntime;
  const allowedStatuses = new Set([
    'disabled',
    'waiting_for_instance',
    'waiting_for_gateway',
    'needs_computer_use',
    'needs_cli_update',
    'shortcut_conflict',
    'ready',
    'running',
    'error'
  ]);
  return {
    config: normalizeA0TagConfig(value),
    shortcut: 'CommandOrControl+Shift+Enter',
    status: allowedStatuses.has(runtime?.status) ? runtime.status : 'error',
    message: String(runtime?.message || '').slice(0, 512),
    profiles: normalizeProfiles(runtime?.profiles),
    running: runtime?.running === true
  };
}

function gatewayIdForTab(settings, tab) {
  const identity = hostAccessIdentity(tab);
  return identity ? launcherGatewayId(settings?.installationId) : '';
}

function gatewayHostForTab(tab) {
  return gatewayHostUrl(tab?.gatewayHost || tab?.url);
}

function a0TagTabForInstanceKey(instanceKey) {
  const key = String(instanceKey || '').trim();
  if (!key) return null;
  for (const tab of instanceTabs.values()) {
    if (hostGatewayLeaseKey(tab) === key && tab?.view?.webContents && !tab.view.webContents.isDestroyed?.()) {
      return tab;
    }
  }
  return null;
}

function resolveA0TagLease(instanceKey) {
  const tab = a0TagTabForInstanceKey(instanceKey);
  const readiness = a0TagLeaseReadiness(tab, process.platform);
  if (!readiness.ready) return readiness;
  const gateway = tab.hostAccess.gateway;
  const leaseKey = hostGatewayLeaseKey(tab);
  return {
    ...readiness,
    tab,
    leaseKey,
    leaseToken: `${leaseKey}:${Number(tab.a0TagLeaseVersion) || 0}:${String(gateway.id || '')}`
  };
}

async function requestA0TagGateway(instanceKey, payload, options = {}) {
  const lease = resolveA0TagLease(instanceKey);
  if (!lease.ready) {
    const error = new Error(lease.message);
    error.code = lease.code;
    throw error;
  }
  return await hostGatewaySupervisor.request(lease.leaseKey, payload, {
    ...options,
    statusOnError: false
  });
}

async function transcribeA0TagMicrophone(instanceKey) {
  const initial = resolveA0TagLease(instanceKey);
  if (!initial.ready) {
    const error = new Error(initial.message);
    error.code = initial.code;
    throw error;
  }
  if (process.platform === 'darwin') {
    const permission = await ensureMacMicrophonePermission(systemPreferences, { prompt: true });
    if (!permission.granted) {
      const error = new Error(macMicrophonePermissionMessage({ isPackaged: app.isPackaged }));
      error.code = 'A0_TAG_MICROPHONE_PERMISSION_REQUIRED';
      throw error;
    }
  }
  const result = await runA0TagMicrophone(initial.tab.view.webContents);
  const current = resolveA0TagLease(instanceKey);
  if (!current.ready || current.leaseToken !== initial.leaseToken) {
    const error = new Error('The selected Instance lease changed before the transcript was ready.');
    error.code = 'A0_TAG_LEASE_CHANGED';
    throw error;
  }
  return result;
}

async function a0TagMicrophoneStatus(instanceKey) {
  const initial = resolveA0TagLease(instanceKey);
  if (!initial.ready) {
    const error = new Error(initial.message);
    error.code = initial.code;
    throw error;
  }
  const result = await getA0TagMicrophoneStatus(initial.tab.view.webContents);
  const current = resolveA0TagLease(instanceKey);
  if (!current.ready || current.leaseToken !== initial.leaseToken) {
    const error = new Error('The selected Instance lease changed while checking Whisper STT.');
    error.code = 'A0_TAG_LEASE_CHANGED';
    throw error;
  }
  return result;
}

async function cancelA0TagInstanceMicrophone(instanceKey) {
  const tab = a0TagTabForInstanceKey(instanceKey);
  return tab ? await cancelA0TagMicrophone(tab.view.webContents) : false;
}

async function selectA0TagAttachments(kind, parentWindow) {
  if (!parentWindow || parentWindow.isDestroyed?.()) return [];
  const folder = kind === 'folder';
  const result = await dialog.showOpenDialog(parentWindow, {
    title: folder ? 'Attach folder to Agent Zero' : 'Attach files to Agent Zero',
    buttonLabel: folder ? 'Attach folder' : 'Attach',
    properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
}

function a0CliSupportsTag(cli) {
  const binary = existingFilePath(cli);
  if (!binary) return false;
  try {
    const result = childProcess.spawnSync(binary, ['headless', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      windowsHide: true
    });
    const help = `${result.stdout || ''}\n${result.stderr || ''}`;
    return result.status === 0 && ['--launcher-tag', '--agent-profile', '--attachment-ref']
      .every((flag) => help.includes(flag));
  } catch {
    return false;
  }
}

async function resolveA0TagLaunch(instanceKey) {
  const initial = resolveA0TagLease(instanceKey);
  if (!initial.ready) {
    const error = new Error(initial.message);
    error.code = initial.code;
    throw error;
  }
  const cli = findA0CliBinary({ requireGateway: true });
  if (!a0CliSupportsTag(cli)) {
    const error = new Error('Update A0 CLI to use A0 Tag.');
    error.code = 'CLI_UPDATE_REQUIRED';
    throw error;
  }
  const workspace = await resolveTabHostWorkspace(initial.tab, initial.tab.hostAccessConfig || {});
  if (!workspace.path) {
    const error = new Error('The selected Instance has no available Host access workspace.');
    error.code = 'HOST_FOLDER_REQUIRED';
    throw error;
  }
  const credentials = await instanceCredentialsForCliTarget(initial.tab);
  const current = resolveA0TagLease(instanceKey);
  if (!current.ready || current.leaseToken !== initial.leaseToken) {
    const error = new Error('The selected Instance lease changed while A0 Tag was preparing.');
    error.code = 'A0_TAG_LEASE_CHANGED';
    throw error;
  }
  const host = gatewayHostForTab(current.tab);
  return {
    cli,
    host,
    workspace: workspace.path,
    env: a0CliLaunchEnv(host, credentials),
    leaseToken: current.leaseToken
  };
}

function publishA0TagRuntime(runtime) {
  a0TagRuntime = runtime && typeof runtime === 'object' ? runtime : a0TagRuntime;
  if (!contentInitialized || mainWindowMode !== 'app') return;
  void dockerManager.getDockerManagerState().then((state) => {
    sendDockerManagerEvent('docker-manager:state', sanitizeDockerManagerState(state));
  }).catch(() => {});
}

function a0CliSupportsGateway(cli) {
  const binary = existingFilePath(cli);
  if (!binary) return false;
  try {
    const result = childProcess.spawnSync(binary, ['gateway', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      windowsHide: true
    });
    return gatewayHelpSupportsLauncher(result);
  } catch {
    return false;
  }
}

async function coreSupportsLauncherGateway(host) {
  let endpoint;
  try {
    endpoint = new URL(`${String(host || '').replace(/\/+$/, '')}/api/plugins/_a0_connector/v1/capabilities`).href;
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref?.();
  try {
    const response = await net.fetch(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'user-agent': `A0-Launcher/${app.getVersion()}` },
      signal: controller.signal
    });
    if (!response.ok) return false;
    return coreCapabilitiesSupportLauncher(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTabHostWorkspace(tab, config) {
  if (tab?.kind === 'local' && tab.containerId) {
    try {
      const storage = await dockerManager.getLocalInstanceStorageFolder(tab.containerId);
      const mountedFolder = existingDirectoryPath(storage?.path);
      if (mountedFolder) {
        return { path: mountedFolder, source: 'instance_workspace' };
      }
    } catch (error) {
      if (error?.code !== 'WORKSPACE_FOLDER_UNAVAILABLE') throw error;
    }
  }
  const configuredFolder = existingDirectoryPath(config?.folder);
  return configuredFolder
    ? { path: configuredFolder, source: 'configured' }
    : { path: '', source: '' };
}

async function persistGatewayConfigForTab(leaseKey, gateway) {
  const tab = instanceTabForGatewayLease(leaseKey);
  const identity = hostAccessIdentity(tab);
  if (!tab || !identity || !gateway || typeof gateway !== 'object') return;
  const current = tab.hostAccessConfig || {};
  const configurationMatches = hostAccessMatchesGateway(current, gateway);
  if (tab.gatewayConfigSynchronized !== true) {
    if (configurationMatches) tab.gatewayConfigSynchronized = true;
    return;
  }
  const next = {
    ...current,
    masterEnabled: gateway.master_enabled !== false,
    scopes: gateway.scopes && typeof gateway.scopes === 'object'
      ? gateway.scopes
      : current.scopes
  };
  const unchanged = current.masterEnabled === next.masterEnabled &&
    JSON.stringify(current.scopes || {}) === JSON.stringify(next.scopes || {});
  tab.hostAccessConfig = next;
  if (tab.hostAccess) tab.hostAccess.config = next;
  if (unchanged) return;
  try {
    await dockerManager.setInstanceHostAccess(identity.kind, identity.id, next);
  } catch (error) {
    console.error('[host-gateway] unable to persist gateway scope state', error);
  }
}

async function startHostGatewayForTab(tab, { force = false } = {}) {
  if (!tab || !instanceTabs.has(tab.id)) return null;
  tab.a0TagLeaseVersion = (Number(tab.a0TagLeaseVersion) || 0) + 1;
  const identity = hostAccessIdentity(tab);
  if (!identity) {
    setTabHostAccess(tab, hostAccessStatus('error', {
      code: 'INSTANCE_NOT_FOUND',
      message: 'This tab has no stable Instance identity.'
    }), null);
    return null;
  }

  const settings = await dockerManager.getHostAccessSettings();
  const config = resolveInstanceHostAccess(settings, identity, tab.hostAccessConfig);
  tab.hostAccessConfig = config;
  tab.computerUseSetupStarted = false;
  tab.gatewayConfigSynchronized = false;
  if (pendingComputerUseSetup.delete(config.key)) tab.forcePromptComputerUseSetup = true;
  if (!config.configured) {
    setTabHostAccess(tab, hostAccessStatus('disconnected', {
      message: identity.kind === 'remote' ? 'Using the remote machine.' : 'This computer is not connected.'
    }), config);
    return null;
  }

  let workspace;
  try {
    workspace = await resolveTabHostWorkspace(tab, config);
  } catch (error) {
    setTabHostAccess(tab, hostAccessStatus('error', {
      code: error?.code || 'WORKSPACE_LOOKUP_FAILED',
      message: error?.message || 'Unable to resolve the host workspace.',
      retryable: true
    }), config);
    return null;
  }
  if (!workspace.path) {
    setTabHostAccess(tab, hostAccessStatus('needs_action', {
      code: 'HOST_FOLDER_REQUIRED',
      message: 'Choose a folder for files and commands.'
    }), config);
    return null;
  }

  try {
    await ensureA0CliInstalled();
  } catch {
    // The capability check below reports the actionable Host access state.
  }

  let cli;
  try {
    cli = findA0CliBinary({ requireGateway: true });
  } catch {
    cli = '';
  }
  if (!cli) {
    setTabHostAccess(tab, hostAccessStatus('needs_action', {
      code: 'CLI_UPDATE_REQUIRED',
      message: 'Launcher Host access could not be prepared. Update A0 CLI, then retry.'
    }), config);
    return null;
  }

  const host = gatewayHostForTab(tab);
  try {
    if (!host || !await coreSupportsLauncherGateway(host)) {
      setTabHostAccess(tab, hostAccessStatus('needs_action', {
        code: 'CORE_UPDATE_REQUIRED',
        message: 'Update this Agent Zero Instance to use Host access.'
      }), config);
      return null;
    }
  } catch (error) {
    setTabHostAccess(tab, hostAccessStatus('error', {
      code: 'CORE_UNREACHABLE',
      message: error?.message || 'Unable to check Agent Zero gateway support.',
      retryable: true
    }), config);
    return null;
  }

  if (!instanceTabs.has(tab.id)) return null;
  let credentials;
  try {
    credentials = await instanceCredentialsForCliTarget(tab);
  } catch (error) {
    setTabHostAccess(tab, hostAccessStatus('needs_action', {
      code: error?.code || 'CREDENTIALS_UNREADABLE',
      message: error?.message || 'Saved Instance credentials could not be read.'
    }), config);
    return null;
  }
  const launch = {
    cli,
    host,
    workspace: workspace.path,
    gatewayId: gatewayIdForTab(settings, tab),
    hostLabel: os.hostname() || 'Launcher host',
    masterEnabled: config.masterEnabled,
    scopes: config.scopes,
    browserSelection: config.browserSelection,
    env: a0CliLaunchEnv(host, credentials)
  };
  config.folder = workspace.path;
  config.folderSource = workspace.source;
  tab.hostAccessConfig = config;
  const status = hostGatewaySupervisor.start(hostGatewayLeaseKey(tab), launch, { force });
  setTabHostAccess(tab, status, config);
  return status;
}

async function restartHostGatewayForTab(tab) {
  if (!tab || !instanceTabs.has(tab.id)) return null;
  const leaseKey = hostGatewayLeaseKey(tab);
  if (hostGatewaySupervisor.isSuppressed(leaseKey)) {
    const settings = await dockerManager.getHostAccessSettings();
    const identity = hostAccessIdentity(tab);
    const config = identity
      ? resolveInstanceHostAccess(settings, identity, tab.hostAccessConfig)
      : tab.hostAccessConfig;
    const status = {
      ...hostGatewaySupervisor.statusFor(leaseKey),
      message: 'Disconnected for this tab. Reconnect here or close and reopen the tab.',
      suppressed: true
    };
    setTabHostAccess(tab, status, config);
    return status;
  }
  hostGatewaySupervisor.stop(leaseKey, 'settings_changed');
  setTabHostAccess(tab, hostAccessStatus('connecting', {
    message: 'Updating Host access…'
  }), tab.hostAccessConfig || null);
  return await startHostGatewayForTab(tab, { force: true });
}

function gatewaySupportsComputerUseSetup(status = {}) {
  return Array.isArray(status?.gateway?.features) &&
    status.gateway.features.includes('computer_use_setup_v1');
}

function setComputerUseSetupStatus(tab, setup = {}) {
  if (!tab || !instanceTabs.has(tab.id)) return;
  const computerStatus = tab.hostAccess?.gateway?.status?.computer_use || {};
  tab.hostAccess = {
    ...(tab.hostAccess || {}),
    gateway: {
      ...(tab.hostAccess?.gateway || {}),
      status: {
        ...(tab.hostAccess?.gateway?.status || {}),
        computer_use: {
          ...computerStatus,
          setup: {
            ...(computerStatus.setup || {}),
            ...setup
          }
        }
      }
    }
  };
  sendInstanceTabsEvent();
}

async function prepareLauncherMacAccessibility(tab, { prompt = false } = {}) {
  if (process.platform !== 'darwin') return { granted: true, prompted: false };
  if (tab?.macAccessibilitySetupPromise) return await tab.macAccessibilitySetupPromise;
  const pending = ensureMacAccessibilityPermission(systemPreferences, {
    prompt,
    timeoutMs: MAC_ACCESSIBILITY_SETUP_TIMEOUT_MS,
    onPrompt() {
      setComputerUseSetupStatus(tab, {
        state: 'accessibility_required',
        accessibility: 'required',
        message: macAccessibilityPermissionMessage({ isPackaged: app.isPackaged })
      });
    }
  });
  if (tab) tab.macAccessibilitySetupPromise = pending;
  try {
    return await pending;
  } finally {
    if (tab?.macAccessibilitySetupPromise === pending) tab.macAccessibilitySetupPromise = null;
  }
}

async function requestComputerUseSetup(tab, { prompt = false } = {}) {
  if (tab?.computerUseSetupRequestPromise) return await tab.computerUseSetupRequestPromise;
  const pending = hostGatewaySupervisor.request(
    hostGatewayLeaseKey(tab),
    { action: 'setup_computer_use', prompt },
    { timeoutMs: 150000 }
  );
  if (tab) tab.computerUseSetupRequestPromise = pending;
  try {
    return await pending;
  } finally {
    if (tab?.computerUseSetupRequestPromise === pending) tab.computerUseSetupRequestPromise = null;
  }
}

function signalComputerUseSetupDialog(tab) {
  if (!tab || !instanceTabs.has(tab.id)) return;
  tab.hostAccess = {
    ...(tab.hostAccess || {}),
    openComputerUseSetup: true
  };
  sendInstanceTabsEvent();
  tab.hostAccess.openComputerUseSetup = false;
}

async function maybeStartComputerUseSetup(tab, status = tab?.hostAccess || {}) {
  if (process.platform !== 'darwin' || !tab || !instanceTabs.has(tab.id)) return;
  const config = tab.hostAccessConfig || {};
  if (
    tab.computerUseSetupStarted ||
    config.configured !== true ||
    config.masterEnabled === false ||
    config.scopes?.computer_use !== true ||
    !gatewaySupportsComputerUseSetup(status)
  ) {
    return;
  }
  const computer = status?.gateway?.status?.computer_use || {};
  if (String(computer.backend_family || computer.backend_id || '').toLowerCase() !== 'macos') return;

  tab.computerUseSetupStarted = true;
  try {
    const forcePrompt = tab.forcePromptComputerUseSetup === true;
    const prompt = forcePrompt;
    tab.forcePromptComputerUseSetup = false;
    setComputerUseSetupStatus(tab, {
      state: 'checking',
      message: 'Checking macOS permissions…'
    });
    if (prompt || tab.openComputerUseSetupAfterRestart === true) {
      tab.openComputerUseSetupAfterRestart = false;
      signalComputerUseSetupDialog(tab);
    }
    if (prompt) {
      const accessibility = await prepareLauncherMacAccessibility(tab, { prompt: true });
      if (!accessibility.granted) return;
    }
    const result = await requestComputerUseSetup(tab, { prompt });
    if (result?.state === 'restart_required') signalComputerUseSetupDialog(tab);
  } catch (error) {
    console.warn('[host-gateway] Computer Use setup failed', error?.message || error);
  }
}

function disconnectHostGatewayForTab(tab) {
  if (!tab || !instanceTabs.has(tab.id)) return null;
  const leaseKey = hostGatewayLeaseKey(tab);
  if (!hostGatewaySupervisor.disconnect(leaseKey)) return null;
  return hostGatewaySupervisor.statusFor(leaseKey);
}

async function reconnectHostGatewayForTab(tab) {
  if (!tab || !instanceTabs.has(tab.id)) return null;
  const leaseKey = hostGatewayLeaseKey(tab);
  if (!hostGatewaySupervisor.isSuppressed(leaseKey)) return null;
  hostGatewaySupervisor.stop(leaseKey, 'user_reconnect');
  setTabHostAccess(tab, hostAccessStatus('connecting', {
    message: 'Reconnecting this computer…'
  }), tab.hostAccessConfig || null);
  return await startHostGatewayForTab(tab, { force: true });
}

function applyDetachedInstanceBounds(tab) {
  const detachedWindow = tab?.detachedWindow;
  if (!detachedWindow || detachedWindow.isDestroyed() || !tab?.view) return;
  try {
    tab.view.setBounds(detachedInstanceContentBounds(
      detachedWindow.getContentBounds(),
      tab.detachedContentVisible !== false
    ));
  } catch {
    // The window or view may be closing.
  }
}

async function openDetachedInstanceWindow(tab) {
  const iconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );
  const detachedWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: tab.title,
    icon: iconPath,
    show: false,
    backgroundColor: '#131313',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  attachWindowDiagnostics(detachedWindow);
  detachedWindow.webContents.on('page-title-updated', (event) => event.preventDefault());
  detachedWindow.on('resize', () => applyDetachedInstanceBounds(tab));
  await detachedWindow.loadURL(
    `a0app://content/components/docker-manager/instance-tabs/detached.html?tabId=${encodeURIComponent(tab.id)}`
  );
  detachedWindow.setTitle(tab.title);
  return detachedWindow;
}

const INSTANCE_CONTEXT_MENU_ITEMS = Object.freeze({
  undo: { label: 'Undo', method: 'undo' },
  redo: { label: 'Redo', method: 'redo' },
  cut: { label: 'Cut', method: 'cut' },
  copy: { label: 'Copy', method: 'copy' },
  paste: { label: 'Paste', method: 'paste' },
  delete: { label: 'Delete', method: 'delete' },
  selectAll: { label: 'Select All', method: 'selectAll' }
});

function attachInstanceContextMenu(webContents) {
  if (!webContents || typeof webContents.on !== 'function') return;

  webContents.on('context-menu', (_event, params) => {
    const template = instanceContextMenuActions(params).map((action) => {
      if (action === 'separator') return { type: 'separator' };
      const item = INSTANCE_CONTEXT_MENU_ITEMS[action];
      return {
        label: item.label,
        click: () => {
          if (!webContents.isDestroyed?.() && typeof webContents[item.method] === 'function') {
            webContents[item.method]();
          }
        }
      };
    });

    if (template.length) {
      const ownerWindow = BrowserWindow.fromWebContents(webContents);
      const window = ownerWindow && !ownerWindow.isDestroyed()
        ? ownerWindow
        : mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : undefined;
      Menu.buildFromTemplate(template).popup({ window });
    }
  });
}

function instanceTabForWebRequest(details) {
  if (details?.webContents) {
    const tab = findInstanceTabByWebContents(instanceTabs, details.webContents);
    if (tab) return tab;
  }

  const webContentsId = Number(details?.webContentsId);
  if (!Number.isInteger(webContentsId)) return null;
  for (const tab of instanceTabs.values()) {
    if (tab?.view?.webContents?.id === webContentsId || tab?.detachedWindow?.webContents?.id === webContentsId) {
      return tab;
    }
  }
  return null;
}

function showCredentialSavePrompt(owner) {
  const width = 496;
  const height = 226;
  const ownerBounds = owner.getBounds();
  const promptWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(ownerBounds.x + (ownerBounds.width - width) / 2),
    y: Math.round(ownerBounds.y + (ownerBounds.height - height) / 2),
    parent: owner,
    modal: true,
    title: 'Save credentials',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (save) => {
      if (settled) return;
      settled = true;
      if (!promptWindow.isDestroyed()) promptWindow.close();
      resolve(save);
    };

    promptWindow.setMenuBarVisibility(false);
    promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    promptWindow.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      const decision = credentialSavePromptDecision(url);
      if (decision !== null) finish(decision);
    });
    promptWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    promptWindow.webContents.on('render-process-gone', () => finish(false));
    promptWindow.once('ready-to-show', () => {
      if (owner.isDestroyed()) finish(false);
      else promptWindow.show();
    });
    promptWindow.on('closed', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    promptWindow.loadFile(path.join(__dirname, 'credential_prompt.html')).catch(() => finish(false));
  });
}

async function offerToSaveInstanceCredentials(tabId, credentials, requestWebContents) {
  const tab = instanceTabs.get(tabId);
  if (!tab || tab.credentialSavePrompted) return;
  tab.credentialSavePrompted = true;

  try {
    const saved = tab.kind === 'remote'
      ? await dockerManager.getRemoteInstanceCredentials(tab.instanceId)
      : await dockerManager.getLocalInstanceCredentials(tab.containerId);
    if (saved) return;
  } catch {
    return;
  }

  const requestOwner = requestWebContents && !requestWebContents.isDestroyed?.()
    ? BrowserWindow.fromWebContents(requestWebContents)
    : null;
  const owner = requestOwner ||
    (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  if (!owner) return;

  let shouldSave;
  try {
    shouldSave = await showCredentialSavePrompt(owner);
  } catch {
    return;
  }
  if (!shouldSave || !instanceTabs.has(tabId)) return;

  try {
    if (tab.kind === 'remote') {
      await dockerManager.setRemoteInstanceCredentials(tab.instanceId, credentials);
    } else {
      await dockerManager.setLocalInstanceCredentials(tab.containerId, credentials);
    }
  } catch (error) {
    const errorOptions = {
      type: 'error',
      title: 'Save credentials',
      message: 'Credentials could not be saved.',
      detail: error?.message || 'Secure credential storage is not available.',
      buttons: ['OK']
    };
    try {
      if (owner && !owner.isDestroyed()) await dialog.showMessageBox(owner, errorOptions);
      else await dialog.showMessageBox(errorOptions);
    } catch {
      // The owning window may be closing.
    }
  }
}

function observeInstanceLoginRequests(webContents) {
  const session = webContents?.session;
  if (!session?.webRequest || observedInstanceLoginSessions.has(session)) return;
  observedInstanceLoginSessions.add(session);

  const pending = new Map();
  const filter = { urls: ['http://*/login*', 'https://*/login*'] };
  session.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      const tab = instanceTabForWebRequest(details);
      const credentials = loginCredentialsFromRequest(tab, details);
      if (tab && credentials && !tab.credentialSavePrompted) {
        pending.set(details.id, {
          tabId: tab.id,
          credentials,
          webContents: details.webContents || tab.view?.webContents
        });
      }
    } catch {
      // Never interrupt the user's login if credential detection fails.
    } finally {
      callback({});
    }
  });
  session.webRequest.onBeforeRedirect(filter, (details) => {
    const login = pending.get(details.id);
    pending.delete(details.id);
    if (!login) return;
    const tab = instanceTabs.get(login.tabId);
    if (instanceLoginRedirectSucceeded(tab, details)) {
      void offerToSaveInstanceCredentials(login.tabId, login.credentials, login.webContents);
    }
  });
  session.webRequest.onCompleted(filter, (details) => pending.delete(details.id));
  session.webRequest.onErrorOccurred(filter, (details) => pending.delete(details.id));
}

function getInstanceTabsSnapshot() {
  return makeTabsSnapshot(instanceTabs, activeInstanceTabId);
}

function sendInstanceTabsEvent() {
  const snapshot = getInstanceTabsSnapshot();
  sendDockerManagerEvent('docker-manager:instanceTabs', snapshot);
  for (const tab of instanceTabs.values()) {
    const wc = tab.detachedWindow?.webContents;
    if (wc && !wc.isDestroyed()) wc.send('docker-manager:instanceTabs', snapshot);
  }
  void a0TagController?.refresh?.().catch?.(() => {});
}

function updateOpenInstanceAppearance(kind, id, appearance = {}) {
  const cleanKind = kind === 'remote' ? 'remote' : 'local';
  const cleanId = String(id || '').trim();
  if (!cleanId) return;
  const color = normalizeInstanceColor(appearance?.color);
  const icon = normalizeInstanceIcon(appearance?.icon);
  let changed = false;
  for (const tab of instanceTabs.values()) {
    const matches = cleanKind === 'remote'
      ? tab.kind === 'remote' && tab.instanceId === cleanId
      : tab.kind !== 'remote' && tab.containerId === cleanId;
    if (!matches) continue;
    tab.color = color;
    tab.icon = icon;
    changed = true;
  }
  if (changed) sendInstanceTabsEvent();
}

function nextInstanceTabId() {
  instanceTabSeq += 1;
  return `instance-tab-${instanceTabSeq}`;
}

function createInstanceWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };
}

function sanitizeInstanceTabBounds(body) {
  const source = isPlainObject(body?.bounds) ? body.bounds : body;
  if (!isPlainObject(source)) return null;

  const readNumber = (key) => {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) return null;
    return value;
  };

  const x = readNumber('x');
  const y = readNumber('y');
  const width = readNumber('width');
  const height = readNumber('height');

  if (x === null || y === null || width === null || height === null) return null;
  if (x < 0 || y < 0 || width < 80 || height < 80) return null;
  return { x, y, width, height };
}

function hideInstanceTabView(tab) {
  try {
    tab?.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } catch {
    // ignore
  }
}

function applyActiveInstanceTabBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const tab of instanceTabs.values()) {
    if (tab.detached) continue;
    if (tab.id !== activeInstanceTabId || !instanceTabBounds) {
      hideInstanceTabView(tab);
      continue;
    }
    try {
      tab.view.setBounds(embeddedInstanceContentBounds(
        mainWindow.getContentBounds(),
        instanceTabBounds,
        mainWindow.webContents.getZoomFactor()
      ));
    } catch {
      hideInstanceTabView(tab);
    }
  }
}

function destroyInstanceTab(tab, reason = 'destroyed') {
  if (!tab) return;
  hostGatewaySupervisor.stop(hostGatewayLeaseKey(tab), reason);
  const detachedWindow = tab.detachedWindow;
  tab.detachedWindow = null;
  try {
    if (detachedWindow && !detachedWindow.isDestroyed()) detachedWindow.close();
  } catch {
    // ignore
  }

  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView && typeof mainWindow.contentView.removeChildView === 'function') {
      mainWindow.contentView.removeChildView(tab.view);
    }
  } catch {
    // ignore
  }

  try {
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.close();
  } catch {
    // ignore
  }
}

function cleanupInstanceTabs() {
  for (const tab of instanceTabs.values()) {
    destroyInstanceTab(tab, 'app_cleanup');
  }
  instanceTabs = new Map();
  activeInstanceTabId = '';
  instanceTabBounds = null;
}

function firstEmbeddedInstanceTabId() {
  for (const tab of instanceTabs.values()) {
    if (!tab.detached) return tab.id;
  }
  return '';
}

function isNavigationAllowedForTab(tab, url) {
  if (!tab || typeof url !== 'string') return false;
  return isAllowedInstanceTabNavigationUrl(tab, url);
}

async function openExternalIfSafe(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized || !isAllowedRemoteInstanceUrl(normalized) || isAllowedLocalInstanceUrl(normalized)) {
    return { opened: false };
  }
  await shell.openExternal(normalized);
  return { opened: true };
}

function createTabTargetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeInstanceTabTitle(value, fallback = 'Agent Zero') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  return raw.replace(/\s+/g, ' ').slice(0, 80);
}

async function resolveInstanceUiTarget(body) {
  const request = isPlainObject(body) ? body : {};
  const kind = typeof request.kind === 'string' && request.kind.trim() ? request.kind.trim() : 'local';
  const section = typeof request.section === 'string' ? request.section.trim() : '';

  if (kind === 'remote') {
    const instanceId = typeof request.instanceId === 'string' && request.instanceId.trim()
      ? request.instanceId.trim()
      : typeof request.id === 'string'
        ? request.id.trim()
        : '';
    const remote = await dockerManager.getRemoteInstance(instanceId);
    const url = normalizeHttpUrl(remote?.url);
    if (!url || !isAllowedRemoteInstanceUrl(url)) {
      throw createTabTargetError('INVALID_REMOTE_INSTANCE', 'Invalid remote instance');
    }
    const title = sanitizeInstanceTabTitle(remote?.name, 'Agent Zero');
    const target = {
      kind: 'remote',
      instanceId: typeof remote?.id === 'string' && remote.id ? remote.id : instanceId,
      containerId: '',
      title,
      color: normalizeInstanceColor(remote?.color),
      icon: normalizeInstanceIcon(remote?.icon),
      url
    };
    target.key = makeTabKey(target);
    return target;
  }

  if (kind !== 'local') {
    throw createTabTargetError('INVALID_INPUT', 'Invalid request');
  }

  const containerId = typeof request.containerId === 'string' ? request.containerId.trim() : '';
  if (containerId) {
    const url = instanceUiSectionUrl(await dockerManager.getContainerUiUrl(containerId, {
      timeoutMs: OPEN_UI_READY_TIMEOUT_MS,
      intervalMs: OPEN_UI_READY_INTERVAL_MS
    }), section);
    if (!url || !isAllowedLocalInstanceUrl(url)) {
      throw createTabTargetError('UI_UNAVAILABLE', 'Agent Zero is still starting. Try Open UI again in a moment.');
    }
    const target = {
      kind: 'local',
      instanceId: '',
      containerId,
      section,
      title: sanitizeInstanceTabTitle(request.title, 'Agent Zero'),
      color: normalizeInstanceColor(request.color),
      icon: normalizeInstanceIcon(request.icon),
      url
    };
    target.key = makeTabKey(target);
    return target;
  }

  const state = await dockerManager.refreshDockerManager({ forceRefresh: false });
  const url = instanceUiSectionUrl(state?.uiUrl, section);
  if (!url) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Agent Zero UI is not available. Start a version first.');
  }
  if (!isAllowedLocalInstanceUrl(url)) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Agent Zero UI URL is not available.');
  }

  const target = {
    kind: 'local',
    instanceId: '',
    containerId: '',
    section,
    title: sanitizeInstanceTabTitle(request.title, 'Agent Zero'),
    url
  };
  target.key = makeTabKey(target);
  return target;
}

function findInstanceTabByKey(key) {
  for (const tab of instanceTabs.values()) {
    if (tab.key === key) return tab;
  }
  return null;
}

function setActiveInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab || tab.detached) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }
  activeInstanceTabId = tabId;
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  return getInstanceTabsSnapshot();
}

function selectInstanceHome() {
  activeInstanceTabId = '';
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  return getInstanceTabsSnapshot();
}

function setInstanceTabOrder(orderedIds) {
  const reordered = reorderAttachedInstanceTabs(instanceTabs, orderedIds);
  if (!reordered) {
    throw createTabTargetError('INVALID_INPUT', 'Invalid Instance tab order.');
  }
  instanceTabs = reordered;
  sendInstanceTabsEvent();
  return getInstanceTabsSnapshot();
}

function getInstanceTabIdFromRequest(body) {
  if (!isPlainObject(body)) return '';
  if (typeof body.tabId === 'string') return body.tabId;
  if (typeof body.id === 'string') return body.id;
  return '';
}

function attachInstanceTabEvents(tab) {
  const wc = tab.view.webContents;
  observeInstanceLoginRequests(wc);
  attachInstanceContextMenu(wc);

  const update = () => {
    if (instanceTabs.has(tab.id)) sendInstanceTabsEvent();
  };

  const blockNavigation = (event, url) => {
    if (isNavigationAllowedForTab(tab, url)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    void openExternalIfSafe(url);
  };

  const handleNavigation = (url) => {
    const normalized = normalizeHttpUrl(url);
    if (!normalized || !isNavigationAllowedForTab(tab, normalized)) return;

    const recoveryTarget = instanceTabLoginRecoveryTarget(tab, normalized);
    tab.url = normalized;
    if (recoveryTarget) {
      update();
      if (tab.loginRecoveryAttempted || tab.loginRecoveryInFlight) return;
      tab.loginRecoveryAttempted = true;
      tab.loginRecoveryInFlight = true;
      void (async () => {
        try {
          const login = await loginInstanceWebUiSession(recoveryTarget, wc);
          if (!login.succeeded || !instanceTabs.has(tab.id) || wc.isDestroyed?.()) return;
          tab.url = recoveryTarget.url;
          tab.loading = true;
          update();
          await wc.loadURL(recoveryTarget.url);
        } catch {
          // Leave the login page visible when the recovery request cannot complete.
        } finally {
          tab.loginRecoveryInFlight = false;
        }
      })();
      return;
    }

    tab.loginRecoveryAttempted = false;
    update();
  };

  wc.setWindowOpenHandler(({ url }) => {
    if (isNavigationAllowedForTab(tab, url)) {
      void wc.loadURL(normalizeHttpUrl(url));
    } else {
      void openExternalIfSafe(url);
    }
    return { action: 'deny' };
  });

  wc.on('will-navigate', blockNavigation);
  wc.on('will-redirect', blockNavigation);
  wc.on('did-start-loading', () => {
    tab.loading = true;
    update();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    tab.canReload = true;
    update();
  });
  wc.on('did-fail-load', () => {
    tab.loading = false;
    tab.canReload = true;
    update();
  });
  wc.on('page-title-updated', (_event, title) => {
    if (tab.titleLocked) return;
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (cleanTitle) {
      tab.title = cleanTitle;
      update();
    }
  });
  wc.on('did-navigate', (_event, url) => {
    handleNavigation(url);
  });
  wc.on('did-navigate-in-page', (_event, url) => {
    handleNavigation(url);
  });
  wc.once('destroyed', () => {
    const detachedWindow = tab.detachedWindow;
    tab.detachedWindow = null;
    try {
      if (detachedWindow && !detachedWindow.isDestroyed()) detachedWindow.close();
    } catch {
      // ignore
    }
    hostGatewaySupervisor.stop(hostGatewayLeaseKey(tab), 'web_contents_destroyed');
    if (!instanceTabs.has(tab.id)) return;
    instanceTabs.delete(tab.id);
    if (activeInstanceTabId === tab.id) {
      activeInstanceTabId = firstEmbeddedInstanceTabId();
    }
    applyActiveInstanceTabBounds();
    sendInstanceTabsEvent();
  });
}

async function applyInstanceUiSection(tab, section) {
  const script = instanceUiSectionScript(section);
  const wc = tab?.view?.webContents;
  if (!script || !wc || wc.isDestroyed?.()) return false;
  try {
    return await wc.executeJavaScript(script, true);
  } catch {
    return false;
  }
}

async function openInstanceTab(target) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Launcher window is not available.');
  }

  let existing = findInstanceTabByKey(target.key);
  if (existing?.detached) {
    const detachedWindow = existing.detachedWindow;
    if (detachedWindow && !detachedWindow.isDestroyed()) {
      existing.title = target.title || existing.title;
      existing.color = normalizeInstanceColor(target.color);
      existing.icon = normalizeInstanceIcon(target.icon);
      existing.gatewayHost = gatewayHostUrl(target.url) || existing.gatewayHost || '';
      detachedWindow.setTitle(existing.title);
      detachedWindow.show();
      detachedWindow.focus();
      await applyInstanceUiSection(existing, target.section);
      return { opened: true, tabId: existing.id, focusedExisting: true, detached: true };
    }
    instanceTabs.delete(existing.id);
    hostGatewaySupervisor.stop(hostGatewayLeaseKey(existing), 'detached_window_destroyed');
    existing = null;
  }
  if (existing) {
    existing.title = target.title || existing.title;
    existing.titleLocked = Boolean(target.title) || existing.titleLocked;
    existing.containerId = target.containerId || existing.containerId || '';
    existing.instanceId = target.instanceId || existing.instanceId || '';
    existing.color = normalizeInstanceColor(target.color);
    existing.icon = normalizeInstanceIcon(target.icon);
    existing.gatewayHost = gatewayHostUrl(target.url) || existing.gatewayHost || '';
    const nextUrl = normalizeHttpUrl(target.url);
    const didLogin = await loginInstanceWebUiSession(target, existing.view?.webContents);
    const existingUrl = normalizeHttpUrl(existing.url);
    const existingPath = existingUrl ? new URL(existingUrl).pathname : '';
    if (nextUrl && nextUrl !== normalizeHttpUrl(existing.url)) {
      existing.url = nextUrl;
      existing.loading = true;
      sendInstanceTabsEvent();
      await existing.view?.webContents?.loadURL(nextUrl);
    } else if (nextUrl && didLogin?.attempted && existingPath === '/login') {
      existing.url = nextUrl;
      existing.loading = true;
      sendInstanceTabsEvent();
      await existing.view?.webContents?.loadURL(nextUrl);
    }
    await applyInstanceUiSection(existing, target.section);
    setActiveInstanceTab(existing.id);
    return { opened: true, tabId: existing.id, focusedExisting: true };
  }

  if (!mainWindow.contentView || typeof mainWindow.contentView.addChildView !== 'function') {
    throw createTabTargetError('UI_UNAVAILABLE', 'Launcher Instance tabs are not available.');
  }

  const previousActiveTabId = activeInstanceTabId;
  const view = new WebContentsView({ webPreferences: createInstanceWebPreferences() });
  tagLauncherWebContents(view.webContents);
  view.setBackgroundColor('#131313');
  const tab = {
    id: nextInstanceTabId(),
    key: target.key,
    kind: target.kind,
    title: target.title,
    titleLocked: Boolean(target.title),
    url: target.url,
    containerId: target.containerId || '',
    instanceId: target.instanceId || '',
    color: normalizeInstanceColor(target.color),
    icon: normalizeInstanceIcon(target.icon),
    gatewayHost: gatewayHostUrl(target.url),
    loading: true,
    canReload: true,
    hostAccess: hostAccessStatus('connecting', { message: 'Preparing Launcher Host access…' }),
    hostAccessConfig: null,
    view
  };

  instanceTabs.set(tab.id, tab);
  mainWindow.contentView.addChildView(view);
  attachInstanceTabEvents(tab);
  activeInstanceTabId = tab.id;
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();

  try {
    await loginInstanceWebUiSession(target, view.webContents);
    await view.webContents.loadURL(target.url);
    await applyInstanceUiSection(tab, target.section);
    void startHostGatewayForTab(tab);
  } catch (error) {
    instanceTabs.delete(tab.id);
    destroyInstanceTab(tab, 'open_failed');
    if (activeInstanceTabId === tab.id) {
      activeInstanceTabId = instanceTabs.has(previousActiveTabId)
        ? previousActiveTabId
        : firstEmbeddedInstanceTabId();
    }
    applyActiveInstanceTabBounds();
    sendInstanceTabsEvent();
    throw error;
  }

  return { opened: true, tabId: tab.id, focusedExisting: false };
}

function closeInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }

  instanceTabs.delete(tabId);
  destroyInstanceTab(tab, 'tab_closed');
  if (activeInstanceTabId === tabId) {
    activeInstanceTabId = firstEmbeddedInstanceTabId();
  }
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  return getInstanceTabsSnapshot();
}

function reloadInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }
  const wc = tab.view?.webContents;
  reloadInstanceWebContents(wc);
  return { reloaded: true, tabId };
}

async function detachInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }
  if (tab.detached) {
    tab.detachedWindow?.show();
    tab.detachedWindow?.focus();
    return { detached: true, tabId };
  }

  const detachedWindow = await openDetachedInstanceWindow(tab);
  if (!instanceTabs.has(tabId)) {
    detachedWindow.close();
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab was closed before it could be detached.');
  }

  tab.detached = true;
  tab.detachedWindow = detachedWindow;
  tab.detachedContentVisible = true;
  const closeDetachedLease = () => {
    if (tab.detachedWindow !== detachedWindow) return;
    tab.detachedWindow = null;
    instanceTabs.delete(tabId);
    destroyInstanceTab(tab, 'detached_window_closed');
    if (activeInstanceTabId === tabId) activeInstanceTabId = firstEmbeddedInstanceTabId();
    applyActiveInstanceTabBounds();
    sendInstanceTabsEvent();
    try {
      if (!detachedWindow.isDestroyed()) detachedWindow.close();
    } catch {
      // ignore
    }
  };
  detachedWindow.once('closed', closeDetachedLease);
  detachedWindow.webContents.once('destroyed', closeDetachedLease);

  try {
    mainWindow.contentView.removeChildView(tab.view);
    detachedWindow.contentView.addChildView(tab.view);
    applyDetachedInstanceBounds(tab);
  } catch (error) {
    tab.detached = false;
    tab.detachedWindow = null;
    try { mainWindow.contentView.addChildView(tab.view); } catch { /* ignore */ }
    detachedWindow.close();
    throw error;
  }
  if (activeInstanceTabId === tabId) {
    activeInstanceTabId = firstEmbeddedInstanceTabId();
  }
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  detachedWindow.show();
  return { detached: true, tabId };
}

function reattachInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab?.detached || !tab.detachedWindow || tab.detachedWindow.isDestroyed()) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Detached Instance tab not found.');
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Launcher window is not available.');
  }

  const detachedWindow = tab.detachedWindow;
  detachedWindow.contentView.removeChildView(tab.view);
  try {
    mainWindow.contentView.addChildView(tab.view);
  } catch (error) {
    try { detachedWindow.contentView.addChildView(tab.view); } catch { /* ignore */ }
    throw error;
  }
  tab.detached = false;
  tab.detachedWindow = null;
  tab.detachedContentVisible = true;
  activeInstanceTabId = tab.id;
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  detachedWindow.close();
  return { detached: false, tabId };
}

function shellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function powerShellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, `''`)}'`;
}

function powerShellArrayLiteral(values) {
  return `@(${values.map((value) => powerShellSingleQuote(value)).join(', ')})`;
}

function shellCommandArgs(values) {
  return values.map((value) => shellSingleQuote(value)).join(' ');
}

function powerShellCommandArgs(values) {
  return values.map((value) => powerShellSingleQuote(value)).join(' ');
}

function appleScriptString(value) {
  return JSON.stringify(String(value || ''));
}

function existingFilePath(filePath) {
  const candidate = String(filePath || '').trim();
  if (!candidate) return '';
  try {
    return fsSync.existsSync(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

function existingDirectoryPath(dirPath) {
  const candidate = typeof dirPath === 'string' ? dirPath : '';
  if (!candidate) return '';
  try {
    const resolved = path.resolve(candidate);
    return fsSync.statSync(resolved).isDirectory() ? resolved : '';
  } catch {
    return '';
  }
}

async function chooseA0CliWorkingDirectory(ownerWindow) {
  const options = {
    title: 'Open A0 CLI From Folder',
    buttonLabel: 'Open A0 CLI',
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'createDirectory']
  };
  const result = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result?.canceled) return '';

  const selected = Array.isArray(result?.filePaths) ? result.filePaths[0] : '';
  const directory = existingDirectoryPath(selected);
  if (!directory) {
    const err = new Error('Choose an existing folder before opening the A0 CLI terminal.');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  return directory;
}

function firstPathLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function findCommandOnPath(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';

  if (process.platform === 'win32') {
    try {
      const found = childProcess.spawnSync('where.exe', [cmd], {
        encoding: 'utf8',
        windowsHide: true
      });
      if (found.status === 0) return firstPathLine(found.stdout);
    } catch {
      // ignore
    }
    return '';
  }

  try {
    const found = childProcess.spawnSync('sh', ['-lc', `command -v ${shellSingleQuote(cmd)}`], {
      encoding: 'utf8'
    });
    if (found.status === 0) return firstPathLine(found.stdout);
  } catch {
    // ignore
  }
  return '';
}

function findA0CliCommandBinary() {
  const binary = process.platform === 'win32' ? 'a0.exe' : 'a0';
  const pathCommand = findCommandOnPath('a0');
  if (pathCommand) return pathCommand;

  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', binary)
      ]
    : [
        path.join(home, '.local', 'bin', binary),
        '/opt/homebrew/bin/a0',
        '/usr/local/bin/a0',
        '/usr/bin/a0'
      ];

  for (const candidate of candidates) {
    const existing = existingFilePath(candidate);
    if (existing) return existing;
  }
  return '';
}

function getA0CliStatus() {
  const commandPath = findA0CliCommandBinary();
  return {
    installed: !!commandPath,
    installing: a0CliEnsureState === 'checking' || a0CliEnsureState === 'installing',
    command: commandPath ? 'a0' : ''
  };
}

function findA0CliBinary({ requireGateway = false } = {}) {
  const repoRoot = USING_LOCAL_CONTENT ? LOCAL_REPO_DIR : path.resolve(__dirname, '..');
  const siblingConnector = path.resolve(repoRoot, '..', 'a0-connector');
  const siblingBinary = process.platform === 'win32'
    ? path.join(siblingConnector, '.venv', 'Scripts', 'a0.exe')
    : path.join(siblingConnector, '.venv', 'bin', 'a0');
  const commandBinary = findA0CliCommandBinary();
  const preferredCandidates = USING_LOCAL_CONTENT
    ? [siblingBinary, commandBinary]
    : [commandBinary, siblingBinary];
  const candidates = process.platform === 'win32'
    ? [
        process.env.A0_CLI_PATH,
        ...preferredCandidates,
        path.join(os.homedir(), '.local', 'bin', 'a0.exe')
      ]
    : [
        process.env.A0_CLI_PATH,
        ...preferredCandidates,
        '/home/eclypso/a0/a0-connector/.venv/bin/a0',
        '/opt/homebrew/bin/a0',
        '/usr/local/bin/a0',
        '/usr/bin/a0'
      ];

  for (const candidate of candidates) {
    const existing = existingFilePath(candidate);
    if (existing && (!requireGateway || a0CliSupportsGateway(existing))) return existing;
  }

  const err = new Error(requireGateway
    ? 'A0 CLI with Launcher gateway support was not found.'
    : 'A0 CLI was not found. Install a0-connector or add the a0 command to PATH.');
  err.code = requireGateway ? 'CLI_UPDATE_REQUIRED' : 'TERMINAL_UNAVAILABLE';
  throw err;
}

function findCompatibleA0CliBinary() {
  try {
    return findA0CliBinary({ requireGateway: true });
  } catch {
    return '';
  }
}

function readA0CliVersion(cli) {
  const binary = existingFilePath(cli);
  if (!binary) return '';
  try {
    const result = childProcess.spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      windowsHide: true
    });
    return normalizeA0CliVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
  } catch {
    return '';
  }
}

async function fetchLatestA0CliVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  timer.unref?.();
  try {
    const response = await net.fetch(A0_CLI_RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'A0-Launcher'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const payload = await response.json();
    return normalizeA0CliVersion(payload?.tag_name);
  } finally {
    clearTimeout(timer);
  }
}

async function publishA0CliStatus() {
  if (!contentInitialized || mainWindowMode !== 'app') return;
  try {
    const state = await dockerManager.getDockerManagerState();
    sendDockerManagerEvent('docker-manager:state', sanitizeDockerManagerState(state));
  } catch {
    // The next normal Docker Manager refresh carries the CLI state.
  }
}

function setA0CliEnsureState(state, binary = '') {
  a0CliEnsureState = state;
  if (binary) a0CliResolvedBinary = binary;
  void publishA0CliStatus();
}

function ensureA0CliInstalled({ force = false } = {}) {
  if (a0CliEnsurePromise) return a0CliEnsurePromise;
  const readyCli = a0CliEnsureState === 'ready' ? existingFilePath(a0CliResolvedBinary) : '';
  if (!force && readyCli) return Promise.resolve(readyCli);

  a0CliEnsurePromise = (async () => {
    setA0CliEnsureState('checking');
    const installedCli = findA0CliCommandBinary();
    const supportsGateway = !!installedCli && a0CliSupportsGateway(installedCli);
    const currentVersion = readA0CliVersion(installedCli);
    let latestVersion = '';
    if (installedCli && supportsGateway) {
      try {
        latestVersion = await fetchLatestA0CliVersion();
      } catch (error) {
        console.warn('[a0-cli] update check failed; using the installed compatible CLI', error?.message || error);
      }
    }

    const installRequired = force || shouldInstallA0Cli({
      installed: !!installedCli,
      supportsGateway,
      currentVersion,
      latestVersion
    });
    if (!installRequired) {
      const compatible = findCompatibleA0CliBinary() || installedCli;
      setA0CliEnsureState('ready', compatible);
      return compatible;
    }

    setA0CliEnsureState('installing');
    try {
      if (installedCli && supportsGateway) {
        await runA0CliUpdate(installedCli);
      } else {
        await runA0CliInstaller({ fetch: net.fetch.bind(net) });
      }
      const installed = findA0CliCommandBinary();
      if (!installed || !a0CliSupportsGateway(installed)) {
        const error = new Error('The installed A0 CLI does not provide Launcher Host access.');
        error.code = 'CLI_INSTALL_FAILED';
        throw error;
      }
      setA0CliEnsureState('ready', installed);
      return installed;
    } catch (error) {
      const compatible = findCompatibleA0CliBinary();
      if (compatible) {
        console.warn('[a0-cli] install or update failed; keeping the compatible CLI', error?.message || error);
        setA0CliEnsureState('ready', compatible);
        if (force) throw error;
        return compatible;
      }
      setA0CliEnsureState('error');
      throw error;
    }
  })();
  const pending = a0CliEnsurePromise;
  const clearPending = () => {
    if (a0CliEnsurePromise === pending) a0CliEnsurePromise = null;
  };
  pending.then(clearPending, clearPending);
  return pending;
}

function a0CliSupportsOption(cli, option) {
  const binary = existingFilePath(cli);
  const flag = String(option || '').trim();
  if (!binary || !flag) return false;

  try {
    const checked = childProcess.spawnSync(binary, ['--help'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      windowsHide: true
    });
    const helpText = `${checked.stdout || ''}\n${checked.stderr || ''}`;
    return helpText.includes(flag);
  } catch {
    return false;
  }
}

function a0CliLaunchArgs(host, cli) {
  const args = ['--host', host];
  if (a0CliSupportsOption(cli, '--connect')) {
    args.push('--no-docker-discovery', '--connect');
  }
  return args;
}

function findDockerCliBinary() {
  const binary = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const overrides = [
    existingFilePath(process.env.A0_DOCKER_CLI_PATH),
    existingFilePath(process.env.DOCKER_CLI_PATH)
  ].filter(Boolean);
  if (overrides.length) return overrides[0];

  const pathCommand = findCommandOnPath(binary);
  if (pathCommand) return pathCommand;

  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Docker', 'resources', 'bin', 'docker.exe'),
        'C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe'
      ]
    : process.platform === 'darwin'
      ? [
          '/opt/homebrew/bin/docker',
          '/usr/local/bin/docker',
          '/usr/bin/docker',
          '/Applications/Docker.app/Contents/Resources/bin/docker',
          path.join(home, 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin', 'docker')
        ]
      : [
          '/usr/bin/docker',
          '/usr/local/bin/docker',
          '/snap/bin/docker'
        ];

  for (const candidate of candidates) {
    const existing = existingFilePath(candidate);
    if (existing) return existing;
  }

  const err = new Error('Docker CLI was not found. Finish Docker Setup, then try again.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function spawnDetached(command, args, options = {}) {
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...options
  });
  child.unref();
  return child;
}

function terminalWrapperDir() {
  const dir = path.join(app.getPath('userData'), 'terminal-wrappers');
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDockerLoginShellWrapper(dockerCli) {
  const scriptPath = path.join(terminalWrapperDir(), 'docker-login.sh');
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    'clear 2>/dev/null || true',
    'echo "Agent Zero Docker Login"',
    'echo',
    'echo "Sign in to Docker Hub so Agent Zero image downloads can continue."',
    'echo "When login succeeds, return to Agent Zero and click Retry."',
    'echo',
    `${shellSingleQuote(dockerCli)} login`,
    'code=$?',
    'echo',
    'if [ "$code" -eq 0 ]; then',
    '  echo "Docker login completed."',
    'else',
    '  echo "Docker login exited with code $code."',
    'fi',
    'echo',
    'read -r -p "Press Enter to close this window..." _',
    'exit "$code"',
    ''
  ].join('\n');
  fsSync.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
  try {
    fsSync.chmodSync(scriptPath, 0o700);
  } catch {
    // Best-effort on platforms that ignore POSIX modes.
  }
  return scriptPath;
}

function writeDockerLoginPowerShellWrapper(dockerCli) {
  const scriptPath = path.join(terminalWrapperDir(), 'docker-login.ps1');
  const script = [
    'Write-Host "Agent Zero Docker Login"',
    'Write-Host ""',
    'Write-Host "Sign in to Docker Hub so Agent Zero image downloads can continue."',
    'Write-Host "When login succeeds, return to Agent Zero and click Retry."',
    'Write-Host ""',
    `& ${powerShellSingleQuote(dockerCli)} login`,
    '$code = $LASTEXITCODE',
    'Write-Host ""',
    'if ($code -eq 0) {',
    '  Write-Host "Docker login completed."',
    '} else {',
    '  Write-Host "Docker login exited with code $code."',
    '}',
    'Write-Host ""',
    'Read-Host "Press Enter to close this window"',
    'exit $code',
    ''
  ].join('\r\n');
  fsSync.writeFileSync(scriptPath, script, { encoding: 'utf8' });
  return scriptPath;
}

function writeA0CliLaunchShellWrapper(host, cli, workingDirectory) {
  const scriptPath = path.join(terminalWrapperDir(), 'a0-cli-launch.sh');
  const cliArgs = a0CliLaunchArgs(host, cli);
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    `cd -- ${shellSingleQuote(workingDirectory)} || exit 1`,
    `export AGENT_ZERO_HOST=${shellSingleQuote(host)}`,
    'export TERM="${TERM:-xterm-256color}"',
    'export COLORTERM="${COLORTERM:-truecolor}"',
    'export LANG="${LANG:-C.UTF-8}"',
    'export LC_CTYPE="${LC_CTYPE:-$LANG}"',
    'export PATH="${HOME:+$HOME/.local/bin:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"',
    `${shellSingleQuote(cli)} ${shellCommandArgs(cliArgs)}`,
    'code=$?',
    'echo',
    'if [ "$code" -ne 0 ]; then',
    '  echo "A0 CLI exited with code $code."',
    'fi',
    'if [ -n "${SHELL:-}" ] && [ -x "${SHELL:-}" ]; then',
    '  exec "$SHELL" -l',
    'fi',
    'exec /bin/bash -l',
    ''
  ].join('\n');
  fsSync.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
  try {
    fsSync.chmodSync(scriptPath, 0o700);
  } catch {
    // Best-effort on platforms that ignore POSIX modes.
  }
  return scriptPath;
}

function writeA0CliLaunchPowerShellWrapper(host, cli, workingDirectory) {
  const scriptPath = path.join(terminalWrapperDir(), 'a0-cli-launch.ps1');
  const cliArgs = a0CliLaunchArgs(host, cli);
  const script = [
    `$env:AGENT_ZERO_HOST = ${powerShellSingleQuote(host)}`,
    `Set-Location -LiteralPath ${powerShellSingleQuote(workingDirectory)}`,
    `& ${powerShellSingleQuote(cli)} ${powerShellCommandArgs(cliArgs)}`,
    '$code = $LASTEXITCODE',
    'if ($null -eq $code) { $code = 0 }',
    'if ($code -ne 0) {',
    '  Write-Host ""',
    '  Write-Host "A0 CLI exited with code $code."',
    '}',
    ''
  ].join('\r\n');
  fsSync.writeFileSync(scriptPath, script, { encoding: 'utf8' });
  return scriptPath;
}

function a0CliLaunchEnv(host, credentials = null) {
  const env = { ...process.env, AGENT_ZERO_HOST: host };
  const username = typeof credentials?.username === 'string' ? credentials.username.trim() : '';
  const password = typeof credentials?.password === 'string' ? credentials.password : '';
  if (username && password) {
    env.A0_USERNAME = username;
    env.A0_PASSWORD = password;
  }
  return env;
}

function normalizeContainerId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 128) return '';
  return /^[a-f0-9]+$/i.test(id) ? id : '';
}

function credentialsErrorShouldBlockCli(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  return code === 'CREDENTIAL_STORAGE_UNAVAILABLE' || code === 'CREDENTIALS_UNREADABLE';
}

async function localInstanceCredentialsForCli(containerId) {
  const id = normalizeContainerId(containerId);
  if (!id) return null;
  try {
    return await dockerManager.getLocalInstanceCredentials(id);
  } catch (error) {
    if (credentialsErrorShouldBlockCli(error)) throw error;
    return null;
  }
}

async function remoteInstanceCredentialsForCli(instanceId) {
  const id = String(instanceId || '').trim();
  if (!id) return null;
  try {
    return await dockerManager.getRemoteInstanceCredentials(id);
  } catch (error) {
    if (credentialsErrorShouldBlockCli(error)) throw error;
    return null;
  }
}

async function instanceCredentialsForCliTarget(target) {
  if (!cliCredentialsAllowedForTarget(target)) return null;
  if (target?.kind === 'remote') return await remoteInstanceCredentialsForCli(target.instanceId);
  return await localInstanceCredentialsForCli(target?.containerId);
}

async function remoteInstanceCredentialsForWebUi(instanceId) {
  const id = String(instanceId || '').trim();
  if (!id) return null;
  try {
    return await dockerManager.getRemoteInstanceCredentials(id);
  } catch {
    return null;
  }
}

async function loginInstanceWebUiSession(target, webContents) {
  if (!webContents?.session || typeof webContents.session.fetch !== 'function') {
    return { attempted: false };
  }

  let credentials = null;
  try {
    if (target?.kind === 'local') {
      credentials = await localInstanceCredentialsForCli(target.containerId);
    } else if (target?.kind === 'remote') {
      credentials = await remoteInstanceCredentialsForWebUi(target.instanceId);
    }
  } catch {
    return { attempted: false };
  }
  const request = webUiLoginRequestForTarget(target, credentials);
  if (!request) return { attempted: false };

  try {
    const response = await webContents.session.fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: request.body,
      redirect: 'manual',
      credentials: 'include'
    });
    return {
      attempted: true,
      succeeded: response.status === 0 || (response.status >= 300 && response.status < 400)
    };
  } catch {
    return { attempted: true, succeeded: false };
  }
}

function openA0CliTerminalWindows(host, cli, workingDirectory, credentials = null) {
  const scriptPath = writeA0CliLaunchPowerShellWrapper(host, cli, workingDirectory);
  const psArgs = ['-NoLogo', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  const env = a0CliLaunchEnv(host, credentials);

  if (findCommandOnPath('wt.exe')) {
    try {
      spawnDetached('wt.exe', [
        'new-tab',
        '--title',
        'A0 CLI',
        '--startingDirectory',
        workingDirectory,
        'powershell.exe',
        ...psArgs
      ], { env, cwd: workingDirectory });
      return { opened: true, command: 'wt.exe' };
    } catch {
      // Fall through to PowerShell's own console window.
    }
  }

  const launcherScript = [
    `$argumentList = ${powerShellArrayLiteral(psArgs)}`,
    `Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WorkingDirectory ${powerShellSingleQuote(workingDirectory)} -WindowStyle Normal`
  ].join('; ');
  const launched = childProcess.spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    launcherScript
  ], {
    encoding: 'utf8',
    env,
    cwd: workingDirectory,
    windowsHide: true
  });
  if (launched.error || launched.status !== 0) {
    const detail = launched.error?.message || launched.stderr?.trim() || `PowerShell exited with code ${launched.status}`;
    const err = new Error(`Could not open the A0 CLI terminal. ${detail}`);
    err.code = 'TERMINAL_UNAVAILABLE';
    throw err;
  }
  return { opened: true, command: 'powershell.exe' };
}

function openA0CliTerminalMac(host, cli, workingDirectory, credentials = null) {
  const scriptPath = writeA0CliLaunchShellWrapper(host, cli, workingDirectory);
  const command = `bash ${shellSingleQuote(scriptPath)}`;

  spawnDetached('osascript', [
    '-e',
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e',
    'tell application "Terminal" to activate'
  ], {
    env: a0CliLaunchEnv(host, credentials),
    cwd: workingDirectory
  });
  return { opened: true, command: 'Terminal.app' };
}

function openA0CliTerminalLinux(host, cli, workingDirectory, credentials = null) {
  const scriptPath = writeA0CliLaunchShellWrapper(host, cli, workingDirectory);
  const env = a0CliLaunchEnv(host, credentials);
  const candidates = [
    ['gnome-terminal', ['--', 'bash', scriptPath]],
    ['konsole', ['-e', 'bash', scriptPath]],
    ['xfce4-terminal', ['--working-directory', workingDirectory, '-e', `bash ${shellSingleQuote(scriptPath)}`]],
    ['x-terminal-emulator', ['-e', 'bash', scriptPath]],
    ['xterm', ['-e', 'bash', scriptPath]]
  ];

  let lastError = null;
  for (const [cmd, args] of candidates) {
    try {
      const found = findCommandOnPath(cmd);
      if (!found) continue;
      spawnDetached(cmd, args, {
        env,
        cwd: workingDirectory
      });
      return { opened: true, command: cmd };
    } catch (error) {
      lastError = error;
    }
  }

  const err = new Error(lastError?.message || 'No terminal emulator was found.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function openDockerLoginTerminalWindows(dockerCli) {
  const scriptPath = writeDockerLoginPowerShellWrapper(dockerCli);
  const psArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];

  if (findCommandOnPath('wt.exe')) {
    try {
      spawnDetached('wt.exe', ['new-tab', '--title', 'Docker Login', 'powershell.exe', ...psArgs], { env: process.env });
      return { opened: true, command: 'wt.exe' };
    } catch {
      // Fall through to PowerShell's own console window.
    }
  }

  const launcherScript = [
    `$argumentList = ${powerShellArrayLiteral(psArgs)}`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WindowStyle Normal"
  ].join('; ');
  const launched = childProcess.spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    launcherScript
  ], {
    encoding: 'utf8',
    env: process.env,
    windowsHide: true
  });
  if (launched.error || launched.status !== 0) {
    const detail = launched.error?.message || launched.stderr?.trim() || `PowerShell exited with code ${launched.status}`;
    const err = new Error(`Could not open the Docker login terminal. ${detail}`);
    err.code = 'TERMINAL_UNAVAILABLE';
    throw err;
  }
  return { opened: true, command: 'powershell.exe' };
}

function openDockerLoginTerminalMac(dockerCli) {
  const scriptPath = writeDockerLoginShellWrapper(dockerCli);
  const command = `bash ${shellSingleQuote(scriptPath)}`;

  spawnDetached('osascript', [
    '-e',
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e',
    'tell application "Terminal" to activate'
  ], {
    env: process.env
  });
  return { opened: true, command: 'Terminal.app' };
}

function openDockerLoginTerminalLinux(dockerCli) {
  const scriptPath = writeDockerLoginShellWrapper(dockerCli);
  const command = `bash ${shellSingleQuote(scriptPath)}`;
  const candidates = [
    ['gnome-terminal', ['--', 'bash', '-lc', command]],
    ['x-terminal-emulator', ['-e', 'bash', '-lc', command]],
    ['konsole', ['-e', 'bash', '-lc', command]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(command)}`]],
    ['xterm', ['-e', 'bash', '-lc', command]]
  ];

  let lastError = null;
  for (const [cmd, args] of candidates) {
    try {
      const found = findCommandOnPath(cmd);
      if (!found) continue;
      spawnDetached(cmd, args, { env: process.env });
      return { opened: true, command: cmd };
    } catch (error) {
      lastError = error;
    }
  }

  const err = new Error(lastError?.message || 'No terminal emulator was found.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function openDockerLoginTerminal() {
  const dockerCli = findDockerCliBinary();
  if (process.platform === 'win32') return openDockerLoginTerminalWindows(dockerCli);
  if (process.platform === 'darwin') return openDockerLoginTerminalMac(dockerCli);
  if (process.platform === 'linux') return openDockerLoginTerminalLinux(dockerCli);

  const err = new Error('Opening the Docker login terminal is not available on this system.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

async function resolveA0CliTerminalTarget(host, options = {}) {
  const request = isPlainObject(options) ? options : {};
  const kind = typeof request.kind === 'string' ? request.kind.trim() : '';
  if (kind === 'remote') {
    const instanceId = typeof request.instanceId === 'string' ? request.instanceId.trim() : '';
    const remote = await dockerManager.getRemoteInstance(instanceId);
    const url = normalizeHttpUrl(remote?.url);
    if (!url || !isAllowedRemoteInstanceUrl(url)) {
      throw createTabTargetError('INVALID_REMOTE_INSTANCE', 'Invalid remote instance');
    }
    return {
      kind: 'remote',
      instanceId: typeof remote?.id === 'string' && remote.id ? remote.id : instanceId,
      containerId: '',
      url
    };
  }

  const h = String(host || '').trim();
  if (!isAllowedLocalUrl(h)) {
    const err = new Error('Start an instance before opening the A0 CLI terminal.');
    err.code = 'UI_UNAVAILABLE';
    throw err;
  }
  return {
    kind: 'local',
    instanceId: '',
    containerId: normalizeContainerId(request.containerId),
    url: h
  };
}

async function openA0CliTerminal(host, ownerWindow, options = {}) {
  const target = await resolveA0CliTerminalTarget(host, options);
  const cli = findA0CliCommandBinary() || await ensureA0CliInstalled();
  const credentials = await instanceCredentialsForCliTarget(target);
  const workingDirectory = await chooseA0CliWorkingDirectory(ownerWindow);
  if (!workingDirectory) return { opened: false, canceled: true };

  if (process.platform === 'win32') return openA0CliTerminalWindows(target.url, cli, workingDirectory, credentials);
  if (process.platform === 'darwin') return openA0CliTerminalMac(target.url, cli, workingDirectory, credentials);
  if (process.platform === 'linux') return openA0CliTerminalLinux(target.url, cli, workingDirectory, credentials);

  const err = new Error('Opening the A0 CLI terminal is not available on this system.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function getDockerDesktopInstallerConfig() {
  if (process.platform === 'win32') {
    return {
      url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      fileName: 'Docker-Desktop-Installer.exe'
    };
  }
  if (process.platform === 'darwin') {
    const isArm = process.arch === 'arm64';
    return {
      url: isArm
        ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg'
        : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
      fileName: 'Docker.dmg'
    };
  }
  return null;
}

async function installDockerDesktop() {
  const cfg = getDockerDesktopInstallerConfig();
  if (!cfg) {
    await shell.openExternal('https://docs.docker.com/engine/install/');
    return { started: true, openedDocs: true };
  }

  const response = await net.fetch(cfg.url, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'A0-Launcher'
    }
  });
  if (!response.ok) {
    throw new Error(`Docker download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const targetPath = path.join(app.getPath('downloads'), cfg.fileName);
  await fs.writeFile(targetPath, buffer);

  if (process.platform === 'darwin') {
    await shell.openPath(targetPath);
    return { started: true, installerPath: targetPath, installerType: 'dmg' };
  }

  const opened = await shell.openPath(targetPath);
  if (opened) {
    throw new Error(`Failed to open Docker installer: ${opened}`);
  }
  return { started: true, installerPath: targetPath, installerType: 'exe' };
}

async function openHostFolder(folderPath) {
  const targetPath = typeof folderPath === 'string' ? folderPath.trim() : '';
  if (!targetPath) {
    return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Storage folder is not available.' });
  }
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Storage folder is not a directory.' });
    }
    const opened = await shell.openPath(targetPath);
    if (opened) {
      return dockerManager.toErrorResponse({ code: 'OPEN_FAILED', message: opened });
    }
    return { opened: true };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return dockerManager.toErrorResponse({ code: 'WORKSPACE_FOLDER_NOT_FOUND', message: 'Storage folder was not found.' });
    }
    return dockerManager.toErrorResponse(error);
  }
}

async function chooseDeveloperProject(ownerWindow, ownerId, mode) {
  const openFile = mode === 'file';
  const options = {
    title: openFile ? 'Open Docker Project File' : 'Open Docker Project',
    buttonLabel: openFile ? 'Open File' : 'Open Project',
    defaultPath: os.homedir(),
    properties: openFile ? ['openFile'] : ['openDirectory', 'createDirectory']
  };
  const result = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result?.canceled) return { canceled: true };
  const selected = Array.isArray(result?.filePaths) ? result.filePaths[0] : '';
  if (!selected) return { canceled: true };
  const root = openFile ? path.dirname(selected) : selected;
  return developerProjects.loadDeveloperProject(ownerId, root, openFile ? selected : '');
}

async function exportDeveloperFile(ownerWindow, fileName, content) {
  const suggestedName = developerProjects.developerFileKind(fileName) ? fileName : 'compose.yaml';
  const options = {
    title: 'Export Docker Project File',
    buttonLabel: 'Export',
    defaultPath: path.join(app.getPath('downloads'), suggestedName),
    properties: ['createDirectory', 'showOverwriteConfirmation']
  };
  const result = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);
  if (result?.canceled || !result?.filePath) return { canceled: true };
  return developerProjects.writeDeveloperExport(result.filePath, content);
}

function backupDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function ensureZipExtension(filePath) {
  const value = typeof filePath === 'string' ? filePath.trim() : '';
  if (!value) return '';
  return value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
}

async function chooseBackupSavePath(ownerWindow) {
  const options = {
    title: 'Backup Instance /a0/usr',
    buttonLabel: 'Backup',
    defaultPath: path.join(app.getPath('downloads'), `agent-zero-backup-${backupDateStamp()}.zip`),
    filters: [{ name: 'Agent Zero backup', extensions: ['zip'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  };
  const result = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);
  if (result?.canceled) return '';
  return ensureZipExtension(result?.filePath || '');
}

async function chooseBackupRestorePath(ownerWindow) {
  const options = {
    title: 'Restore Instance /a0/usr',
    buttonLabel: 'Restore',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Agent Zero backup', extensions: ['zip'] }],
    properties: ['openFile']
  };
  const result = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result?.canceled) return '';
  const selected = Array.isArray(result?.filePaths) ? result.filePaths[0] : '';
  return existingFilePath(selected);
}

function sanitizeDockerManagerState(state) {
  const versionsIn = Array.isArray(state?.versions) ? state.versions : [];
  const containersIn = Array.isArray(state?.containers) ? state.containers : [];
  const retainedIn = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
  const remoteIn = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  const backgroundIn = Array.isArray(state?.backgroundOperations) ? state.backgroundOperations : [];
  const policyIn = isPlainObject(state?.retentionPolicy) ? state.retentionPolicy : {};
  const portsIn = isPlainObject(state?.portPreferences) ? state.portPreferences : {};
  const storagePrefsIn = isPlainObject(state?.storagePreferences) ? state.storagePreferences : {};
  const defaultsIn = isPlainObject(state?.instanceDefaults) ? state.instanceDefaults : {};
  const hostAccessIn = normalizeHostAccessSettings(state?.hostAccess);
  const a0TagIn = normalizeA0TagConfig(state?.a0Tag);

  const allowedCategory = new Set(['official_release', 'local_build']);
  const allowedAvailability = new Set(['available', 'installed', 'update_available', 'installing', 'error']);
  const allowedInstallability = new Set(['unknown', 'installable', 'not_yet_available']);
  const allowedRemoteHealthStatuses = new Set(['checking', 'online', 'offline']);
  const cleanMatchedReleaseTag = (value) => {
    const tag = typeof value === 'string' ? value.trim() : '';
    return dockerManager.isSemverReleaseTag(tag) ? tag : '';
  };
  const cleanRuntimeText = (value, maxLength) => typeof value === 'string'
    ? value.trim().replace(/[\0-\x1F\x7F]/g, '').slice(0, maxLength)
    : '';
  const copyRuntimeIdentity = (out, source) => {
    const runtimeTag = cleanMatchedReleaseTag(source?.runtimeTag);
    if (runtimeTag) out.runtimeTag = runtimeTag;
    const runtimeVersion = cleanRuntimeText(source?.runtimeVersion, 80);
    if (runtimeVersion) out.runtimeVersion = runtimeVersion;
    const runtimeBranch = cleanRuntimeText(source?.runtimeBranch, 120);
    if (runtimeBranch) out.runtimeBranch = runtimeBranch;
    const runtimeCommit = cleanRuntimeText(source?.runtimeCommit, 64).toLowerCase();
    if (/^[0-9a-f]{7,64}$/.test(runtimeCommit)) out.runtimeCommit = runtimeCommit;
    const runtimeShortCommit = cleanRuntimeText(source?.runtimeShortCommit, 12).toLowerCase();
    if (/^[0-9a-f]{7,12}$/.test(runtimeShortCommit)) out.runtimeShortCommit = runtimeShortCommit;
    if (!isPlainObject(source?.runtimeSource)) return;
    const runtimeSource = {};
    if (source.runtimeSource.type === 'health') runtimeSource.type = 'health';
    const tag = cleanMatchedReleaseTag(source.runtimeSource.tag);
    if (tag) runtimeSource.tag = tag;
    const version = cleanRuntimeText(source.runtimeSource.version, 80);
    if (version) runtimeSource.version = version;
    const describe = cleanRuntimeText(source.runtimeSource.describe, 160);
    if (describe) runtimeSource.describe = describe;
    const branch = cleanRuntimeText(source.runtimeSource.branch, 120);
    if (branch) runtimeSource.branch = branch;
    const commit = cleanRuntimeText(source.runtimeSource.commit, 64).toLowerCase();
    if (/^[0-9a-f]{7,64}$/.test(commit)) runtimeSource.commit = commit;
    const shortCommit = cleanRuntimeText(source.runtimeSource.shortCommit, 12).toLowerCase();
    if (/^[0-9a-f]{7,12}$/.test(shortCommit)) runtimeSource.shortCommit = shortCommit;
    if (Object.keys(runtimeSource).length) out.runtimeSource = runtimeSource;
  };

  const versions = [];
  for (const v of versionsIn) {
    if (!isPlainObject(v)) continue;
    const id = typeof v.id === 'string' ? v.id : '';
    const displayVersion = typeof v.displayVersion === 'string' ? v.displayVersion : '';
    const category = typeof v.category === 'string' ? v.category : '';
    const availability = typeof v.availability === 'string' ? v.availability : '';
    const isActive = typeof v.isActive === 'boolean' ? v.isActive : false;

    if (!id || !displayVersion) continue;
    if (!allowedCategory.has(category)) continue;
    if (!allowedAvailability.has(availability)) continue;

    const out = {
      id,
      displayVersion,
      category,
      availability,
      isActive
    };

    if (Array.isArray(v.channelBadges) && v.channelBadges.every((x) => typeof x === 'string')) {
      out.channelBadges = v.channelBadges;
    }

    if (v.installability === null) {
      out.installability = null;
    } else if (typeof v.installability === 'string' && allowedInstallability.has(v.installability)) {
      out.installability = v.installability;
    }

    if (v.matchHint === null) {
      out.matchHint = null;
    } else if (typeof v.matchHint === 'string') {
      out.matchHint = v.matchHint;
    }

    if (v.digestHint === null) {
      out.digestHint = null;
    } else if (typeof v.digestHint === 'string') {
      out.digestHint = v.digestHint;
    }

    {
      const matchedReleaseTag = cleanMatchedReleaseTag(v.matchedReleaseTag);
      if (matchedReleaseTag) out.matchedReleaseTag = matchedReleaseTag;
    }

    {
      const publishedReleaseTag = cleanMatchedReleaseTag(v.publishedReleaseTag);
      if (publishedReleaseTag) out.publishedReleaseTag = publishedReleaseTag;
    }

    if (typeof v.differsFromPublished === 'boolean') {
      out.differsFromPublished = v.differsFromPublished;
    }

    if (v.activeState === null) {
      out.activeState = null;
    } else if (typeof v.activeState === 'string') {
      out.activeState = v.activeState;
    }

    if (v.publishedAt === null) {
      out.publishedAt = null;
    } else if (typeof v.publishedAt === 'string') {
      out.publishedAt = v.publishedAt;
    }

    if (v.updatedAt === null) {
      out.updatedAt = null;
    } else if (typeof v.updatedAt === 'string') {
      out.updatedAt = v.updatedAt;
    }

    if (v.sizeBytes === null) {
      out.sizeBytes = null;
    } else if (Number.isFinite(Number(v.sizeBytes))) {
      out.sizeBytes = Number(v.sizeBytes);
    }

    versions.push(out);
  }

  const retainedInstances = [];
  for (const r of retainedIn) {
    if (!isPlainObject(r)) continue;
    const containerId = typeof r.containerId === 'string' ? r.containerId : '';
    const containerName = typeof r.containerName === 'string' ? r.containerName : '';
    const versionTag = typeof r.versionTag === 'string' ? r.versionTag : '';
    const retainedAt = typeof r.retainedAt === 'string' ? r.retainedAt : '';
    if (!containerId || !containerName || !versionTag || !retainedAt) continue;
    const out = { containerId, containerName, versionTag, retainedAt };
    if (Number.isFinite(Number(r.createdAt))) out.createdAt = Number(r.createdAt);
    if (Number.isFinite(Number(r.sizeBytes))) out.sizeBytes = Number(r.sizeBytes);
    retainedInstances.push(out);
  }

  const containers = [];
  for (const c of containersIn) {
    if (!isPlainObject(c)) continue;
    const containerId = typeof c.containerId === 'string' ? c.containerId : '';
    const containerName = typeof c.containerName === 'string' ? c.containerName : '';
    if (!containerId || !containerName) continue;
    const out = { containerId, containerName };
    if (typeof c.instanceName === 'string' || c.instanceName === null) out.instanceName = c.instanceName || null;
    {
      const instanceColor = normalizeInstanceColor(c.instanceColor);
      if (instanceColor) out.instanceColor = instanceColor;
    }
    {
      const instanceIcon = normalizeInstanceIcon(c.instanceIcon);
      if (instanceIcon) out.instanceIcon = instanceIcon;
    }
    if (typeof c.imageRef === 'string') out.imageRef = c.imageRef;
    if (typeof c.isBackendImage === 'boolean') out.isBackendImage = c.isBackendImage;
    if (typeof c.tag === 'string') out.tag = c.tag;
    if (typeof c.versionTag === 'string') out.versionTag = c.versionTag;
    {
      const matchedReleaseTag = cleanMatchedReleaseTag(c.matchedReleaseTag);
      if (matchedReleaseTag) out.matchedReleaseTag = matchedReleaseTag;
    }
    copyRuntimeIdentity(out, c);
    if (typeof c.state === 'string' || c.state === null) out.state = c.state || null;
    if (typeof c.status === 'string' || c.status === null) out.status = c.status || null;
    if (Number.isFinite(Number(c.createdAt))) out.createdAt = Number(c.createdAt);
    if (typeof c.uiUrl === 'string' && isAllowedHttpUrl(c.uiUrl)) out.uiUrl = c.uiUrl;
    if (isPlainObject(c.labels)) {
      const labels = {};
      for (const [key, value] of Object.entries(c.labels)) {
        if (typeof key === 'string' && typeof value === 'string') labels[key] = value;
      }
      out.labels = labels;
    }
    if (Array.isArray(c.ports)) {
      out.ports = c.ports.map((p) => ({
        privatePort: Number.isFinite(Number(p?.privatePort)) ? Number(p.privatePort) : null,
        publicPort: Number.isFinite(Number(p?.publicPort)) ? Number(p.publicPort) : null,
        type: typeof p?.type === 'string' ? p.type : null,
        ip: typeof p?.ip === 'string' ? p.ip : null
      }));
    }
    if (isPlainObject(c.workspaceStorage)) {
      const storage = {};
      const allowedModes = new Set(['host_directory', 'named_volume', 'custom_mount', 'legacy_ephemeral', 'ephemeral']);
      if (typeof c.workspaceStorage.mode === 'string' && allowedModes.has(c.workspaceStorage.mode)) {
        storage.mode = c.workspaceStorage.mode;
      }
      if (typeof c.workspaceStorage.target === 'string') storage.target = c.workspaceStorage.target;
      if (typeof c.workspaceStorage.hostPath === 'string') storage.hostPath = c.workspaceStorage.hostPath;
      if (typeof c.workspaceStorage.volumeName === 'string') storage.volumeName = c.workspaceStorage.volumeName;
      if (typeof c.workspaceStorage.persistent === 'boolean') storage.persistent = c.workspaceStorage.persistent;
      if (typeof c.workspaceStorage.legacy === 'boolean') storage.legacy = c.workspaceStorage.legacy;
      if (typeof c.workspaceStorage.migrationAvailable === 'boolean') {
        storage.migrationAvailable = c.workspaceStorage.migrationAvailable;
      }
      if (Object.keys(storage).length) out.workspaceStorage = storage;
    }
    if (isPlainObject(c.launcherCredentials) && c.launcherCredentials.saved === true) {
      out.launcherCredentials = {
        saved: true,
        username: typeof c.launcherCredentials.username === 'string' ? c.launcherCredentials.username : '',
        updatedAt: typeof c.launcherCredentials.updatedAt === 'string' ? c.launcherCredentials.updatedAt : ''
      };
    }
    containers.push(out);
  }

  const keepCount = Number.isFinite(Number(policyIn.keepCount)) ? Number(policyIn.keepCount) : 1;
  const retentionPolicy = { keepCount: Math.max(0, Math.min(20, Math.floor(keepCount))) };

  const normalizePreferenceText = (value, maxLength) => String(value || '')
    .trim()
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, maxLength);
  const defaultProviders = {
    Main: 'openrouter',
    Utility: 'openrouter',
    Embedding: 'huggingface'
  };
  const sourceModels = isPlainObject(defaultsIn.models) ? defaultsIn.models : {};
  const instanceDefaults = { models: {} };
  for (const id of ['Main', 'Utility', 'Embedding']) {
    const source = isPlainObject(sourceModels[id]) ? sourceModels[id] : {};
    instanceDefaults.models[id] = {
      provider: normalizePreferenceText(source.provider, 96) || defaultProviders[id],
      model: normalizePreferenceText(source.model, 256),
      apiKey: normalizePreferenceText(source.apiKey, 4096)
    };
  }

  const remoteInstances = [];
  for (const r of remoteIn) {
    if (!isPlainObject(r)) continue;
    const id = typeof r.id === 'string' ? r.id : '';
    const name = typeof r.name === 'string' ? r.name : '';
    const url = typeof r.url === 'string' ? r.url : '';
    if (!id || !name || !isAllowedHttpUrl(url)) continue;
    const out = { id, name, url };
    const color = normalizeInstanceColor(r.color);
    if (color) out.color = color;
    const icon = normalizeInstanceIcon(r.icon);
    if (icon) out.icon = icon;
    if (typeof r.createdAt === 'string') out.createdAt = r.createdAt;
    if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt;
    if (isPlainObject(r.launcherCredentials) && r.launcherCredentials.saved === true) {
      out.launcherCredentials = {
        saved: true,
        username: typeof r.launcherCredentials.username === 'string' ? r.launcherCredentials.username : '',
        updatedAt: typeof r.launcherCredentials.updatedAt === 'string' ? r.launcherCredentials.updatedAt : ''
      };
    }
    if (isPlainObject(r.health)) {
      const status = typeof r.health.status === 'string' ? r.health.status : '';
      if (allowedRemoteHealthStatuses.has(status)) {
        out.health = { status };
        if (typeof r.health.checkedAt === 'string') out.health.checkedAt = r.health.checkedAt;
        if (typeof r.health.error === 'string' && r.health.error) {
          out.health.error = r.health.error.slice(0, 160);
        }
      }
    }
    copyRuntimeIdentity(out, r);
    remoteInstances.push(out);
  }

  const backgroundOperations = [];
  const allowedBackgroundTypes = new Set(['start', 'stop', 'restart', 'delete_instance']);
  const allowedBackgroundStatuses = new Set(['queued', 'running', 'failed', 'completed']);
  for (const op of backgroundIn) {
    if (!isPlainObject(op)) continue;
    const opId = typeof op.opId === 'string' ? op.opId : '';
    const type = typeof op.type === 'string' && allowedBackgroundTypes.has(op.type) ? op.type : '';
    const status = typeof op.status === 'string' && allowedBackgroundStatuses.has(op.status) ? op.status : '';
    const containerId = typeof op.containerId === 'string' ? op.containerId : '';
    if (!opId || !type || !status || !containerId) continue;
    const out = { opId, type, status, containerId };
    if (typeof op.message === 'string') out.message = op.message;
    if (typeof op.error === 'string' || op.error === null) out.error = op.error || null;
    if (typeof op.errorCode === 'string' || op.errorCode === null) out.errorCode = op.errorCode || null;
    if (typeof op.uiReady === 'boolean') out.uiReady = op.uiReady;
    if (typeof op.queuedAt === 'string') out.queuedAt = op.queuedAt;
    if (typeof op.startedAt === 'string' || op.startedAt === null) out.startedAt = op.startedAt || null;
    if (typeof op.finishedAt === 'string' || op.finishedAt === null) out.finishedAt = op.finishedAt || null;
    backgroundOperations.push(out);
  }

  const outState = {
    onboarding: ['new', 'local', 'complete'].includes(state?.onboarding) ? state.onboarding : null,
    versions,
    containers,
    retainedInstances,
    remoteInstances,
    backgroundOperations,
    retentionPolicy,
    cli: getA0CliStatus(),
    instanceDefaults,
    a0Tag: publicA0TagState(a0TagIn),
    hostAccess: {
      version: 1,
      onboardingComplete: hostAccessIn.onboardingComplete,
      defaults: hostAccessIn.defaults,
      instances: hostAccessIn.instances
    }
  };

  {
    const normalizePort = (value, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      const p = Math.floor(n);
      if (p <= 0 || p > 65535) return fallback;
      return p;
    };

    const prefs = {
      ui: normalizePort(portsIn.ui, 8880),
      ssh: normalizePort(portsIn.ssh, 55022)
    };
    if (prefs.ui !== prefs.ssh) {
      outState.portPreferences = prefs;
    }
  }

  {
    const mode = storagePrefsIn.mode === 'named_volume' ? 'named_volume' : 'host_directory';
    const hostPathMode = storagePrefsIn.hostPathMode === 'exact' ? 'exact' : 'per_instance';
    const cleanText = (value, fallback, maxLength = 512) => {
      const text = String(value || '')
        .trim()
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, maxLength);
      return text || fallback;
    };
    outState.storagePreferences = {
      mode,
      hostRoot: cleanText(storagePrefsIn.hostRoot, '~/agent-zero'),
      hostPathMode,
      volumePrefix: cleanText(storagePrefsIn.volumePrefix, 'a0-launcher', 120)
    };
  }

  if (typeof state?.lastSyncedAt === 'string') outState.lastSyncedAt = state.lastSyncedAt;
  if (typeof state?.offline === 'boolean') outState.offline = state.offline;
  if (state?.uiUrl === null) outState.uiUrl = null;
  if (typeof state?.uiUrl === 'string') outState.uiUrl = state.uiUrl;
  if (isPlainObject(state?.storage)) {
    const s = state.storage;
    const normalizeNullableInt = (value) => {
      if (value === null) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.floor(n));
    };

    const storage = {};

    if (s.dockerRootDir === null) {
      storage.dockerRootDir = null;
    } else if (typeof s.dockerRootDir === 'string') {
      storage.dockerRootDir = s.dockerRootDir;
    }

    if ('freeBytes' in s) storage.freeBytes = normalizeNullableInt(s.freeBytes);
    if ('usedBytes' in s) storage.usedBytes = normalizeNullableInt(s.usedBytes);
    if ('estimateAfterUpdateBytes' in s) storage.estimateAfterUpdateBytes = normalizeNullableInt(s.estimateAfterUpdateBytes);

    outState.storage = storage;
  }

  if (isPlainObject(state?.runtime)) {
    const r = state.runtime;
    const allowedRuntimeStates = new Set(['ready', 'engine_stopped', 'needs_relogin', 'needs_group_membership', 'not_provisioned', 'manual_install', 'unsupported']);
    const allowedRuntimeActions = new Set(['', 'install', 'start', 'manual', 'refresh']);
    const runtimeState = typeof r.state === 'string' && allowedRuntimeStates.has(r.state) ? r.state : 'unsupported';
    const runtime = {
      platform: typeof r.platform === 'string' ? r.platform : process.platform,
      state: runtimeState,
      detail: typeof r.detail === 'string' ? r.detail : '',
      canProvision: !!r.canProvision,
      action: typeof r.action === 'string' && allowedRuntimeActions.has(r.action) ? r.action : ''
    };
    if (typeof r.mode === 'string') runtime.mode = r.mode;
    if (typeof r.distro === 'string') runtime.distro = r.distro;
    if (typeof r.requiresAdmin === 'boolean') runtime.requiresAdmin = r.requiresAdmin;
    if (typeof r.requiresRestart === 'boolean') runtime.requiresRestart = r.requiresRestart;
    if (typeof r.setupActionLabel === 'string') runtime.setupActionLabel = r.setupActionLabel;
    if (typeof r.dockerFlavor === 'string' || r.dockerFlavor === null) runtime.dockerFlavor = r.dockerFlavor;
    if (typeof r.dockerHost === 'string' || r.dockerHost === null) runtime.dockerHost = r.dockerHost;
    if (typeof r.packageManager === 'string') runtime.packageManager = r.packageManager;
    if (Array.isArray(r.manualPackages) && r.manualPackages.every((item) => typeof item === 'string')) {
      runtime.manualPackages = r.manualPackages;
    }
    if (typeof r.manualCommand === 'string') runtime.manualCommand = r.manualCommand;
    if (typeof r.manualUrl === 'string' && /^https?:\/\//i.test(r.manualUrl)) runtime.manualUrl = r.manualUrl;
    if (typeof r.selectedRuntimeEndpointId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(r.selectedRuntimeEndpointId)) {
      runtime.selectedRuntimeEndpointId = r.selectedRuntimeEndpointId;
    }
    if (Array.isArray(r.runtimeCandidates)) {
      runtime.runtimeCandidates = r.runtimeCandidates.slice(0, 32).flatMap((candidate) => {
        if (!isPlainObject(candidate)) return [];
        const id = typeof candidate.id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(candidate.id) ? candidate.id : '';
        const label = typeof candidate.label === 'string' ? candidate.label.trim().slice(0, 120) : '';
        const provider = typeof candidate.provider === 'string' ? candidate.provider.trim().slice(0, 64) : '';
        if (!id || !label || !provider) return [];
        const out = {
          id,
          label,
          provider,
          source: typeof candidate.source === 'string' ? candidate.source.trim().slice(0, 64) : '',
          available: candidate.available === true,
          isSelected: candidate.isSelected === true,
          daemonId: typeof candidate.daemonId === 'string' ? candidate.daemonId.trim().slice(0, 128) || null : null
        };
        if (provider === 'docker_desktop' && out.available === false && candidate.startable === true && candidate.state === 'engine_stopped') {
          out.startable = true;
          out.state = 'engine_stopped';
        }
        return [out];
      });
    }
    outState.runtime = runtime;
  }

  return outState;
}

function sanitizeContainerLogsResult(result) {
  if (!isPlainObject(result)) return { lines: [] };
  const out = {
    containerId: typeof result.containerId === 'string' ? result.containerId : '',
    containerName: typeof result.containerName === 'string' ? result.containerName : '',
    instanceName: typeof result.instanceName === 'string' ? result.instanceName : '',
    fetchedAt: typeof result.fetchedAt === 'string' ? result.fetchedAt : '',
    maxLines: Number.isFinite(Number(result.maxLines)) ? Math.max(0, Math.floor(Number(result.maxLines))) : 0,
    aborted: result.aborted === true,
    lines: []
  };

  for (const evt of Array.isArray(result.lines) ? result.lines : []) {
    if (!isPlainObject(evt)) continue;
    const stream = evt.stream === 'stderr' ? 'stderr' : 'stdout';
    const line = typeof evt.line === 'string' ? evt.line.slice(0, 12_000) : '';
    out.lines.push({
      stream,
      line,
      partial: evt.partial === true
    });
  }

  return out;
}

function sanitizeDockerManagerProgress(progress) {
  if (!isPlainObject(progress)) return null;
  const out = {};
  const hasNumericValue = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

  if (typeof progress.opId === 'string') out.opId = progress.opId;
  if (typeof progress.type === 'string') out.type = progress.type;
  if (typeof progress.status === 'string') out.status = progress.status;
  if (progress.presentation === 'toast') out.presentation = 'toast';
  if (typeof progress.startedAt === 'string') out.startedAt = progress.startedAt;
  if (typeof progress.progressStartedAt === 'string') out.progressStartedAt = progress.progressStartedAt;
  if (hasNumericValue(progress.progressStartValue)) out.progressStartValue = Number(progress.progressStartValue);
  if (typeof progress.finishedAt === 'string') out.finishedAt = progress.finishedAt;
  if (typeof progress.targetTag === 'string') out.targetTag = progress.targetTag;
  if (typeof progress.canCancel === 'boolean') out.canCancel = progress.canCancel;

  if (hasNumericValue(progress.progress)) out.progress = Number(progress.progress);
  if (hasNumericValue(progress.downloadProgress)) out.downloadProgress = Number(progress.downloadProgress);
  if (hasNumericValue(progress.extractProgress)) out.extractProgress = Number(progress.extractProgress);
  if (typeof progress.message === 'string') out.message = progress.message;
  if (typeof progress.headline === 'string') out.headline = progress.headline;
  if (typeof progress.detail === 'string') out.detail = progress.detail;
  if (progress.type === 'developer_project' && typeof progress.developerOutput === 'string') {
    out.developerOutput = progress.developerOutput.slice(-12_000);
  }
  if (typeof progress.phase === 'string' || progress.phase === null) out.phase = progress.phase;
  if (typeof progress.indeterminate === 'boolean') out.indeterminate = progress.indeterminate;
  if (typeof progress.uiReady === 'boolean') out.uiReady = progress.uiReady;
  if (Array.isArray(progress.steps)) {
    out.steps = progress.steps
      .filter((step) => isPlainObject(step) && typeof step.label === 'string')
      .map((step) => ({
        id: typeof step.id === 'string' ? step.id : '',
        label: step.label,
        status: typeof step.status === 'string' ? step.status : 'pending'
      }));
  }
  if (typeof progress.error === 'string') out.error = progress.error;
  if (typeof progress.errorCode === 'string') out.errorCode = progress.errorCode;
  if (isPlainObject(progress.workspaceMigration)) {
    const migration = {};
    const cleanText = (value, maxLength = 160) => String(value || '')
      .trim()
      .replace(/[^\x20-\x7E]/g, '')
      .slice(0, maxLength);
    for (const key of ['sourceName', 'sourceContainerName', 'replacementName', 'replacementContainerName', 'mountTarget']) {
      const value = cleanText(progress.workspaceMigration[key]);
      if (value) migration[key] = value;
    }
    if (Object.keys(migration).length) out.workspaceMigration = migration;
  }

  return out.opId ? out : null;
}

function sendDockerManagerEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

function scheduleRuntimeSetupResume() {
  if (typeof dockerManager.resumeRuntimeSetupIfPending !== 'function') return;
  setTimeout(() => {
    dockerManager.resumeRuntimeSetupIfPending().catch((error) => {
      console.error('[docker-manager] runtime setup resume failed', error);
    });
  }, 1500);
}

function scheduleComputerUseSetupResume() {
  if (!pendingComputerUseResume) return;
  setTimeout(async () => {
    const identity = pendingComputerUseResume;
    pendingComputerUseResume = null;
    try {
      const target = await resolveInstanceUiTarget({
        kind: identity.kind,
        ...(identity.kind === 'remote' ? { instanceId: identity.id } : { containerId: identity.id })
      });
      const opened = await openInstanceTab(target);
      const tab = instanceTabs.get(opened?.tabId);
      if (tab) {
        tab.openComputerUseSetupAfterRestart = true;
        tab.computerUseSetupStarted = false;
        void maybeStartComputerUseSetup(tab, tab.hostAccess);
      }
    } catch (error) {
      console.error('[host-gateway] unable to resume Computer Use setup', error);
    }
  }, 1500).unref?.();
}

dockerManager.events.on('state', (state) => {
  try {
    sendDockerManagerEvent('docker-manager:state', sanitizeDockerManagerState(state));
  } catch {
    // ignore
  }
});

dockerManager.events.on('host-access-computer-use-enabled', (identity = {}) => {
  const key = hostAccessInstanceKey(identity.kind, identity.id);
  if (key) pendingComputerUseSetup.add(key);
});

dockerManager.events.on('progress', (progress) => {
  const sanitized = sanitizeDockerManagerProgress(progress);
  if (sanitized) sendDockerManagerEvent('docker-manager:progress', sanitized);
});

ipcMain.handle('docker-manager:getState', async () => {
  try {
    const state = await dockerManager.getDockerManagerState();
    return sanitizeDockerManagerState(state);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:refresh', async (_event, body) => {
  try {
    const forceRefresh = !isPlainObject(body) || body.forceRefresh !== false;
    const state = await dockerManager.refreshDockerManager({ forceRefresh });
    return sanitizeDockerManagerState(state);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setHostAccessSettings', async (_event, body) => {
  try {
    if (!isPlainObject(body)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid Host access settings' });
    }
    const update = {
      defaults: isPlainObject(body.defaults) ? body.defaults : undefined
    };
    if (typeof body.onboardingComplete === 'boolean') {
      update.onboardingComplete = body.onboardingComplete;
    }
    const saved = await dockerManager.setHostAccessSettings(update);
    for (const tab of instanceTabs.values()) void restartHostGatewayForTab(tab);
    return publicHostAccessSettings(saved);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setSettings', async (_event, body) => {
  try {
    if (!isPlainObject(body)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid Settings request' });
    }
    const ports = isPlainObject(body.portPreferences) ? body.portPreferences : {};
    const storage = isPlainObject(body.storagePreferences) ? body.storagePreferences : {};
    const defaults = isPlainObject(body.instanceDefaults) ? body.instanceDefaults : {};
    const hostAccess = isPlainObject(body.hostAccess) ? body.hostAccess : {};
    const a0Tag = isPlainObject(body.a0Tag) ? body.a0Tag : {};
    const saved = await dockerManager.setSettings({
      portPreferences: { ui: ports.ui, ssh: ports.ssh },
      storagePreferences: {
        mode: typeof storage.mode === 'string' ? storage.mode : '',
        hostRoot: typeof storage.hostRoot === 'string' ? storage.hostRoot : '',
        hostPathMode: typeof storage.hostPathMode === 'string' ? storage.hostPathMode : '',
        volumePrefix: typeof storage.volumePrefix === 'string' ? storage.volumePrefix : ''
      },
      instanceDefaults: { models: isPlainObject(defaults.models) ? defaults.models : {} },
      hostAccess: {
        onboardingComplete: hostAccess.onboardingComplete === true,
        defaults: isPlainObject(hostAccess.defaults) ? hostAccess.defaults : {}
      },
      a0Tag: {
        version: 1,
        enabled: a0Tag.enabled === true,
        instanceKey: typeof a0Tag.instanceKey === 'string' ? a0Tag.instanceKey : '',
        defaultProfile: typeof a0Tag.defaultProfile === 'string' ? a0Tag.defaultProfile : ''
      }
    });
    for (const tab of instanceTabs.values()) void restartHostGatewayForTab(tab);
    await a0TagController?.sync?.(saved.a0Tag);
    const sanitized = sanitizeDockerManagerState({
      portPreferences: saved.portPreferences,
      storagePreferences: saved.storagePreferences,
      instanceDefaults: saved.instanceDefaults
    });
    return {
      portPreferences: sanitized.portPreferences,
      storagePreferences: sanitized.storagePreferences,
      instanceDefaults: sanitized.instanceDefaults,
      hostAccess: publicHostAccessSettings(saved.hostAccess),
      a0Tag: publicA0TagState(saved.a0Tag),
      saved: {
        portPreferences: saved.saved?.portPreferences === true,
        storagePreferences: saved.saved?.storagePreferences === true,
        instanceDefaults: saved.saved?.instanceDefaults === true,
        hostAccess: saved.saved?.hostAccess === true,
        a0Tag: saved.saved?.a0Tag === true
      }
    };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:getA0TagProfiles', async (_event, body) => {
  try {
    if (!isPlainObject(body) || typeof body.instanceKey !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Choose an Agent Zero Instance.' });
    }
    if (!a0TagController) {
      return dockerManager.toErrorResponse({ code: 'A0_TAG_NOT_READY', message: 'A0 Tag is still starting.' });
    }
    return await a0TagController.getProfiles(body.instanceKey);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setInstanceHostAccess', async (_event, body) => {
  try {
    if (!isPlainObject(body)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid Host access settings' });
    }
    const tab = typeof body.tabId === 'string' ? instanceTabs.get(body.tabId) : null;
    const identity = hostAccessIdentity(tab) || {
      kind: body.kind === 'remote' ? 'remote' : 'local',
      id: typeof body.id === 'string' ? body.id : ''
    };
    const config = isPlainObject(body.config) ? body.config : {};
    const key = hostAccessInstanceKey(identity.kind, identity.id);
    const settings = await dockerManager.getHostAccessSettings();
    const existing = key ? settings.instances?.[key] : null;
    const previous = resolveInstanceHostAccess(settings, identity);
    const saved = await dockerManager.setInstanceHostAccess(identity.kind, identity.id, config);
    const previousComputerUse = existing != null &&
      previous.configured === true &&
      previous.masterEnabled !== false &&
      previous.scopes?.computer_use === true;
    const nextComputerUse = saved.configured === true &&
      saved.masterEnabled !== false &&
      saved.scopes?.computer_use === true;
    if (!previousComputerUse && nextComputerUse && saved.key) pendingComputerUseSetup.add(saved.key);
    for (const candidate of instanceTabs.values()) {
      const candidateIdentity = hostAccessIdentity(candidate);
      if (candidateIdentity?.kind === identity.kind && candidateIdentity.id === identity.id) {
        if (!previousComputerUse && nextComputerUse) {
          candidate.forcePromptComputerUseSetup = true;
          candidate.computerUseSetupStarted = false;
          pendingComputerUseSetup.delete(saved.key);
        }
        setTabHostAccess(candidate, candidate.hostAccess || hostAccessStatus('disconnected'), saved);
        void restartHostGatewayForTab(candidate);
      }
    }
    return saved;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:chooseHostAccessFolder', async (event, body) => {
  try {
    const requested = isPlainObject(body) ? existingDirectoryPath(body.defaultPath) : '';
    const options = {
      title: 'Choose Host access folder',
      buttonLabel: 'Use this folder',
      defaultPath: requested || os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    };
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const result = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    if (result?.canceled) return { canceled: true, path: '' };
    const folder = existingDirectoryPath(result?.filePaths?.[0]);
    if (!folder) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Choose an existing folder.' });
    }
    return { canceled: false, path: folder };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:retryHostGateway', async (_event, body) => {
  try {
    const tab = isPlainObject(body) ? instanceTabs.get(String(body.tabId || '')) : null;
    if (!tab) throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
    const status = await restartHostGatewayForTab(tab);
    return status || tab.hostAccess;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:hostGatewayCommand', async (_event, body) => {
  try {
    if (!isPlainObject(body)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid Host access command' });
    }
    const tabId = String(body.tabId || '');
    if (!instanceTabs.has(tabId)) throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
    const action = String(body.action || '');
    const tab = instanceTabs.get(tabId);
    if (action === 'disconnect') {
      const status = disconnectHostGatewayForTab(tab);
      if (!status) throw createTabTargetError('GATEWAY_NOT_RUNNING', 'Host gateway is not running.');
      return { accepted: true, status };
    }
    if (action === 'reconnect') {
      const status = await reconnectHostGatewayForTab(tab);
      if (!status) throw createTabTargetError('RECONNECT_UNAVAILABLE', 'Host access is not waiting to reconnect.');
      return { accepted: true, status };
    }
    if (action === 'restart_computer_use') {
      if (process.platform !== 'darwin') {
        return dockerManager.toErrorResponse({
          code: 'UNSUPPORTED_PLATFORM',
          message: 'Computer Use restart recovery is available on macOS.'
        });
      }
      const identity = hostAccessIdentity(tab);
      if (!identity) throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance identity is unavailable.');
      const resumeArg = `${COMPUTER_USE_RESUME_ARG}${identity.kind}:${identity.id}`;
      const args = process.argv.slice(1).filter((arg) => !String(arg || '').startsWith(COMPUTER_USE_RESUME_ARG));
      app.relaunch({ args: [...args, resumeArg] });
      setTimeout(() => app.quit(), 100);
      return { accepted: true, restarting: true };
    }
    if (!['prepare_browser', 'rearm_computer_use', 'setup_computer_use'].includes(action)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Unsupported Host access command' });
    }
    if (action === 'setup_computer_use' && !gatewaySupportsComputerUseSetup(tab.hostAccess)) {
      return dockerManager.toErrorResponse({
        code: 'CLI_UPDATE_REQUIRED',
        message: 'Update A0 CLI to finish Computer Use setup.'
      });
    }
    if (action === 'setup_computer_use' && body.prompt === true && process.platform === 'darwin') {
      if (tab.macAccessibilitySetupPromise) {
        await tab.macAccessibilitySetupPromise;
        return {
          accepted: true,
          result: tab.hostAccess?.gateway?.status?.computer_use?.setup || { state: 'checking' }
        };
      }
      const accessibility = await prepareLauncherMacAccessibility(tab, { prompt: true });
      if (!accessibility.granted) {
        return {
          accepted: true,
          result: tab.hostAccess?.gateway?.status?.computer_use?.setup || {
            state: 'accessibility_required',
            accessibility: 'required'
          }
        };
      }
    }
    const result = action === 'setup_computer_use'
      ? await requestComputerUseSetup(tab, { prompt: body.prompt === true })
      : await hostGatewaySupervisor.request(
        hostGatewayLeaseKey(tab),
        { action },
        { timeoutMs: action === 'rearm_computer_use' ? 150000 : HOST_BROWSER_PREPARE_TIMEOUT_MS }
      );
    return { accepted: true, result };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:install', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    const accepted = await dockerManager.installOrSync(tag, {
      operationType: body.operationType === 'update' ? 'update' : '',
      presentation: body.presentation === 'toast' ? 'toast' : ''
    });
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Install did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:removeInstalledImage', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    return await dockerManager.removeInstalledImage(tag);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:startActive', async () => {
  try {
    const accepted = await dockerManager.startActiveInstance();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Start did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:stopActive', async () => {
  try {
    const accepted = await dockerManager.stopActiveInstance();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Stop did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:stopLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.stopLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Stop did not return an opId' });
    }
    return { opId: accepted.opId, queued: accepted.queued === true, background: accepted.background === true };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:restartLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.restartLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Restart did not return an opId' });
    }
    return { opId: accepted.opId, queued: accepted.queued === true, background: accepted.background === true };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:startLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.startLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Start did not return an opId' });
    }
    return { opId: accepted.opId, queued: accepted.queued === true, background: accepted.background === true };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:cloneLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const workspaceCategories = Array.isArray(body.workspaceCategories) || isPlainObject(body.workspaceCategories)
      ? body.workspaceCategories
      : null;
    const accepted = await dockerManager.cloneLocalInstance(containerId, { workspaceCategories });
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Clone did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:migrateLocalInstanceStorage', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.migrateLocalInstanceStorage(containerId, {
      storageMode: typeof body.storageMode === 'string' ? body.storageMode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      hostPathMode: typeof body.hostPathMode === 'string' ? body.hostPathMode : '',
      volumeName: typeof body.volumeName === 'string' ? body.volumeName : ''
    });
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Migration did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:backupLocalInstance', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const outputPath = await chooseBackupSavePath(BrowserWindow.fromWebContents(event.sender));
    if (!outputPath) return { canceled: true };
    const accepted = await dockerManager.backupLocalInstance(containerId, outputPath);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Backup did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:restoreLocalInstance', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const inputPath = await chooseBackupRestorePath(BrowserWindow.fromWebContents(event.sender));
    if (!inputPath) return { canceled: true };
    const accepted = await dockerManager.restoreLocalInstance(containerId, inputPath);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Restore did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setRetentionPolicy', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const keepCount = body.keepCount;
    const policy = await dockerManager.setRetentionPolicy(keepCount);
    return { keepCount: policy.keepCount };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setPortPreferences', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const ui = body.ui;
    const ssh = body.ssh;
    const prefs = await dockerManager.setPortPreferences({ ui, ssh });
    return { ui: prefs.ui, ssh: prefs.ssh };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setStoragePreferences', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const prefs = await dockerManager.setStoragePreferences({
      mode: typeof body.mode === 'string' ? body.mode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      hostPathMode: typeof body.hostPathMode === 'string' ? body.hostPathMode : '',
      volumePrefix: typeof body.volumePrefix === 'string' ? body.volumePrefix : ''
    });
    return sanitizeDockerManagerState({ storagePreferences: prefs }).storagePreferences;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setInstanceDefaults', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const defaults = await dockerManager.setInstanceDefaults({
      models: isPlainObject(body.models) ? body.models : {}
    });
    return sanitizeDockerManagerState({ instanceDefaults: defaults }).instanceDefaults;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:beginLocalSetup', async () => {
  try {
    return await dockerManager.beginLocalSetup();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:provisionRuntime', async () => {
  try {
    const accepted = await dockerManager.provisionRuntime();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Runtime setup did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:selectRuntimeEndpoint', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    return await dockerManager.selectRuntimeEndpoint(id);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:addRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const name = typeof body.name === 'string' ? body.name : '';
    const url = typeof body.url === 'string' ? body.url : '';
    const saved = await dockerManager.addRemoteInstance({ name, url });
    const sanitized = sanitizeDockerManagerState({ remoteInstances: [saved] }).remoteInstances?.[0];
    return sanitized || dockerManager.toErrorResponse({ code: 'INVALID_REMOTE_INSTANCE', message: 'Invalid remote instance' });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:deleteRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    return await dockerManager.deleteRemoteInstance(id);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:renameRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    const name = typeof body.name === 'string' ? body.name : '';
    const saved = await dockerManager.renameRemoteInstance(id, name);
    const sanitized = sanitizeDockerManagerState({ remoteInstances: [saved] }).remoteInstances?.[0];
    return sanitized || dockerManager.toErrorResponse({ code: 'INVALID_REMOTE_INSTANCE', message: 'Invalid remote instance' });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setRemoteInstanceAppearance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    const appearance = {};
    if (typeof body.color === 'string') appearance.color = body.color;
    if (typeof body.icon === 'string') appearance.icon = body.icon;
    const saved = await dockerManager.setRemoteInstanceAppearance(id, appearance);
    updateOpenInstanceAppearance('remote', id, saved);
    const sanitized = sanitizeDockerManagerState({ remoteInstances: [saved] }).remoteInstances?.[0];
    return sanitized || dockerManager.toErrorResponse({ code: 'INVALID_REMOTE_INSTANCE', message: 'Invalid remote instance' });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:renameLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const name = typeof body.name === 'string' ? body.name : '';
    return await dockerManager.renameLocalInstance(containerId, name);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setLocalInstanceAppearance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const appearance = {};
    if (typeof body.color === 'string') appearance.color = body.color;
    if (typeof body.icon === 'string') appearance.icon = body.icon;
    const saved = await dockerManager.setLocalInstanceAppearance(containerId, appearance);
    updateOpenInstanceAppearance('local', containerId, saved);
    return saved;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setLocalInstanceCredentials', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const credentials = isPlainObject(body.credentials) ? body.credentials : body;
    return await dockerManager.setLocalInstanceCredentials(containerId, {
      username: typeof credentials.username === 'string' ? credentials.username : '',
      password: typeof credentials.password === 'string' ? credentials.password : ''
    });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:clearLocalInstanceCredentials', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    return await dockerManager.clearLocalInstanceCredentials(containerId);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setRemoteInstanceCredentials', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    const credentials = isPlainObject(body.credentials) ? body.credentials : body;
    return await dockerManager.setRemoteInstanceCredentials(id, {
      username: typeof credentials.username === 'string' ? credentials.username : '',
      password: typeof credentials.password === 'string' ? credentials.password : ''
    });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:clearRemoteInstanceCredentials', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    return await dockerManager.clearRemoteInstanceCredentials(id);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:deleteLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.deleteLocalInstance(containerId, {
      removeStorage: body.removeStorage === true
    });
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Delete did not return an opId' });
    }
    return { opId: accepted.opId, queued: accepted.queued === true, background: accepted.background === true };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:deleteRetainedInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.deleteRetainedInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Delete did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:updateToLatest', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await dockerManager.updateToLatest(dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Update did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:activate', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const options = {
      imageRef: typeof body.imageRef === 'string' ? body.imageRef : '',
      instanceName: typeof body.instanceName === 'string' ? body.instanceName : '',
      portMappings: typeof body.portMappings === 'string' ? body.portMappings : '',
      envText: typeof body.envText === 'string' ? body.envText : '',
      storageMode: typeof body.storageMode === 'string' ? body.storageMode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      hostPathMode: typeof body.hostPathMode === 'string' ? body.hostPathMode : '',
      volumeName: typeof body.volumeName === 'string' ? body.volumeName : '',
      credentials: isPlainObject(body.credentials)
        ? {
            username: typeof body.credentials.username === 'string' ? body.credentials.username : '',
            password: typeof body.credentials.password === 'string' ? body.credentials.password : '',
            remember: body.credentials.remember === true
          }
        : null,
      hostAccess: isPlainObject(body.hostAccess) ? body.hostAccess : null
    };
    const accepted = await dockerManager.activateTag(tag, dataLossAck, options);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Activate did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:runCustomImage', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const options = {
      image: typeof body.image === 'string' ? body.image : '',
      tag: typeof body.tag === 'string' ? body.tag : '',
      instanceName: typeof body.instanceName === 'string' ? body.instanceName : '',
      portMappings: typeof body.portMappings === 'string' ? body.portMappings : '',
      envText: typeof body.envText === 'string' ? body.envText : '',
      mountsText: typeof body.mountsText === 'string' ? body.mountsText : '',
      storageMode: typeof body.storageMode === 'string' ? body.storageMode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      hostPathMode: typeof body.hostPathMode === 'string' ? body.hostPathMode : '',
      volumeName: typeof body.volumeName === 'string' ? body.volumeName : '',
      pull: body.pull !== false
    };
    const accepted = await dockerManager.runCustomImage(options);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Custom image run did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openDeveloperProject', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const mode = body.mode === 'file' ? 'file' : 'folder';
    const ownerId = event.sender.id;
    const project = await chooseDeveloperProject(BrowserWindow.fromWebContents(event.sender), ownerId, mode);
    if (!developerProjectCleanupOwners.has(ownerId)) {
      developerProjectCleanupOwners.add(ownerId);
      event.sender.once('destroyed', () => {
        developerProjects.closeDeveloperProjects(ownerId);
        developerProjectCleanupOwners.delete(ownerId);
      });
    }
    return project;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:saveDeveloperProjectFile', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return await developerProjects.saveDeveloperProjectFile(
      event.sender.id,
      typeof body.projectToken === 'string' ? body.projectToken : '',
      typeof body.fileName === 'string' ? body.fileName : '',
      typeof body.content === 'string' ? body.content : ''
    );
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:exportDeveloperFile', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return await exportDeveloperFile(
      BrowserWindow.fromWebContents(event.sender),
      typeof body.fileName === 'string' ? body.fileName : '',
      typeof body.content === 'string' ? body.content : ''
    );
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:inspectDeveloperProject', async (event, body) => {
  try {
    if (!isPlainObject(body) || !['validate', 'logs'].includes(body.action)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid developer project action' });
    }
    const target = await developerProjects.developerProjectTarget(
      event.sender.id,
      typeof body.projectToken === 'string' ? body.projectToken : '',
      typeof body.fileName === 'string' ? body.fileName : ''
    );
    const result = await dockerManager.inspectDeveloperProject({ ...target, action: body.action });
    return {
      ok: result?.ok === true,
      action: result?.action === 'logs' ? 'logs' : 'validate',
      output: typeof result?.output === 'string' ? result.output.slice(-12_000) : ''
    };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:runDeveloperProject', async (event, body) => {
  try {
    if (!isPlainObject(body) || !['build', 'up', 'stop', 'down'].includes(body.action)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid developer project action' });
    }
    const target = await developerProjects.developerProjectTarget(
      event.sender.id,
      typeof body.projectToken === 'string' ? body.projectToken : '',
      typeof body.fileName === 'string' ? body.fileName : ''
    );
    const accepted = await dockerManager.runDeveloperProject({
      ...target,
      action: body.action,
      imageTag: typeof body.imageTag === 'string' ? body.imageTag : ''
    });
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Docker project action did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:activateRetainedInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await dockerManager.activateRetainedInstance(containerId, dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Rollback did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:cancel', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const opId = typeof body.opId === 'string' ? body.opId : '';
    const result = await dockerManager.cancelOperation(opId);
    return { canceled: !!result?.canceled };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:getInventory', async () => {
  try {
    const inventory = await dockerManager.getDockerInventory();
    return {
      ...inventory,
      hostAccess: publicHostAccessSettings(inventory?.hostAccess),
      a0Tag: publicA0TagState(inventory?.a0Tag)
    };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:getLocalInstanceLogs', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const maxLines = body.maxLines;
    const result = await dockerManager.getLocalInstanceLogs(containerId, { maxLines });
    return sanitizeContainerLogsResult(result);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openLocalInstanceStorageFolder', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const result = await dockerManager.getLocalInstanceStorageFolder(containerId);
    return await openHostFolder(result?.path || '');
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:removeVolume', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const volumeName = typeof body.volumeName === 'string' ? body.volumeName : '';
    return await dockerManager.removeVolume(volumeName);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:pruneVolumes', async () => {
  try {
    const result = await dockerManager.pruneVolumes();
    return { pruned: true, result };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:installDocker', async () => {
  try {
    return await installDockerDesktop();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:getInstanceTabs', async () => {
  try {
    return getInstanceTabsSnapshot();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setInstanceTabBounds', async (_event, body) => {
  try {
    // Bounds reporting is renderer->shell viewport telemetry. It must NOT emit
    // a tab-state event: the renderer reacts to that event by re-measuring and
    // calling setInstanceTabBounds again, which loops indefinitely.
    instanceTabBounds = sanitizeInstanceTabBounds(body);
    applyActiveInstanceTabBounds();
    return { updated: !!instanceTabBounds };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openInstanceUi', async (_event, body) => {
  try {
    const target = await resolveInstanceUiTarget(body);
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:selectInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return setActiveInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:selectInstanceHome', async () => {
  try {
    return selectInstanceHome();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:reorderInstanceTabs', async (_event, body) => {
  try {
    if (!isPlainObject(body) || !Array.isArray(body.ids)) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    }
    return setInstanceTabOrder(body.ids);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:closeInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return closeInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:reloadInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return reloadInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:detachInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return detachInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:reattachInstanceTab', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tab = instanceTabs.get(getInstanceTabIdFromRequest(body));
    if (!tab || tab.detachedWindow?.webContents !== event.sender) {
      throw createTabTargetError('INSTANCE_NOT_FOUND', 'Detached Instance tab not found.');
    }
    return reattachInstanceTab(tab.id);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setDetachedInstanceContentVisible', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tab = instanceTabs.get(getInstanceTabIdFromRequest(body));
    if (!tab || tab.detachedWindow?.webContents !== event.sender) {
      throw createTabTargetError('INSTANCE_NOT_FOUND', 'Detached Instance tab not found.');
    }
    tab.detachedContentVisible = body.visible !== false;
    applyDetachedInstanceBounds(tab);
    return { visible: tab.detachedContentVisible };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openUi', async () => {
  try {
    const target = await resolveInstanceUiTarget({ kind: 'local' });
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openContainerUi', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const target = await resolveInstanceUiTarget({ kind: 'local', containerId });
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    const target = await resolveInstanceUiTarget({ kind: 'remote', instanceId: id });
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openHomepage', async () => {
  try {
    return await openPublicResourceLink('apiDashboard');
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openResourceLink', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    return await openPublicResourceLink(id);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openCliTerminal', async (event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const host = typeof body.host === 'string' ? body.host : '';
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId : '';
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    return await openA0CliTerminal(host, ownerWindow, { kind, containerId, instanceId });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:installCli', async () => {
  const tabs = Array.from(instanceTabs.values());
  try {
    hostGatewaySupervisor.stopAll('cli_update', { preserveSuppression: true });
    if (hostGatewaySupervisor.pendingStopCount()) {
      await hostGatewaySupervisor.waitForStopped(8500);
    }
    const cli = await ensureA0CliInstalled({ force: true });
    return { installed: true, command: cli ? 'a0' : '' };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  } finally {
    for (const tab of tabs) void restartHostGatewayForTab(tab);
  }
});

ipcMain.handle('docker-manager:openDockerLoginTerminal', async () => {
  try {
    return openDockerLoginTerminal();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

// ---------------------------------------------------------------------------
// Custom protocol: a0app://
// Serves app content from disk so that fetch(), new URL(), and module imports
// work naturally (as if served by a web server). This stays in the shell layer
// and is NOT part of the A0 UI core.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
  scheme: 'a0app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

app.on('web-contents-created', (_event, webContents) => {
  webContents.on('before-input-event', (event, input) => {
    const tab = webContents === mainWindow?.webContents
      ? instanceTabs.get(activeInstanceTabId)
      : findInstanceTabByWebContents(instanceTabs, webContents);
    const attachedSurface = webContents === mainWindow?.webContents
      || (tab && !tab.detached && tab.id === activeInstanceTabId);
    if (attachedSurface && (!activeInstanceTabId || instanceTabBounds)) {
      const target = instanceTabShortcutTarget(input, instanceTabs, activeInstanceTabId);
      if (target !== null) {
        event.preventDefault();
        if (target) setActiveInstanceTab(target);
        else selectInstanceHome();
        const selectedContents = target ? instanceTabs.get(target).view.webContents : mainWindow.webContents;
        selectedContents.focus();
        return;
      }
    }
    if (!isInstanceTabReloadShortcut(input)) return;
    if (!tab) return;
    event.preventDefault();
    reloadInstanceWebContents(tab.view?.webContents);
  });
});

// App lifecycle
app.whenReady().then(async () => {
  // Register the a0app:// protocol handler (must be inside whenReady).
  protocol.handle('a0app', (request) => {
    const url = new URL(request.url);
    const contentRoot = USING_LOCAL_CONTENT
      ? path.join(LOCAL_REPO_DIR, 'app')
      : CONTENT_DIR;
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.join(contentRoot, relativePath);

    // Path traversal protection
    const normalizedRoot = path.resolve(contentRoot);
    const normalizedFile = path.resolve(filePath);
    if (!normalizedFile.startsWith(normalizedRoot)) {
      console.log(`[a0app] BLOCKED (traversal): ${request.url} -> ${normalizedFile}`);
      return new Response('Forbidden', { status: 403 });
    }

    const fileUrl = pathToFileURL(normalizedFile).toString();
    console.log(`[a0app] ${request.url} -> ${fileUrl}`);
    return net.fetch(fileUrl);
  });
  const a0TagOverlay = new A0TagOverlay({
    BrowserWindow,
    screen,
    clipboard,
    Notification,
    getMicrophoneStatus: () => a0TagController?.getComposerMicrophoneStatus?.(),
    startMicrophone: () => a0TagController?.startComposerMicrophone?.(),
    cancelMicrophone: () => a0TagController?.cancelComposerMicrophone?.(),
    selectAttachments: (kind, parentWindow) => selectA0TagAttachments(kind, parentWindow)
  });
  gnomeA0TagShortcut = new GnomeA0TagShortcut();
  gnomeA0TagShortcut.cleanup();
  a0TagController = new A0TagController({
    getConfig: () => dockerManager.getA0TagSettings(),
    resolveLease: (instanceKey) => resolveA0TagLease(instanceKey),
    request: (instanceKey, payload, options) => requestA0TagGateway(instanceKey, payload, options),
    resolveLaunch: (instanceKey) => resolveA0TagLaunch(instanceKey),
    microphoneStatus: (instanceKey) => a0TagMicrophoneStatus(instanceKey),
    transcribeMicrophone: (instanceKey) => transcribeA0TagMicrophone(instanceKey),
    cancelMicrophone: (instanceKey) => cancelA0TagInstanceMicrophone(instanceKey),
    globalShortcut,
    registerFallback: () => gnomeA0TagShortcut.register(),
    unregisterFallback: () => gnomeA0TagShortcut.unregister(),
    overlay: a0TagOverlay,
    onState: publishA0TagRuntime
  });
  if (process.platform === 'linux') {
    process.on('SIGUSR2', () => { void a0TagController?.invoke?.(); });
  }
  await a0TagController.sync().catch((error) => {
    console.warn('[a0-tag] unable to initialize', error?.message || error);
  });
  await cleanupStaleLauncherUpdaterArtifacts();
  configureLauncherAutoUpdate();
  void ensureA0CliInstalled().catch((error) => {
    console.warn('[a0-cli] automatic install or update failed', error?.message || error);
  });
  await createWindow();

  const launcherUpdateCheck = checkForLauncherUpdates({ userInitiated: false });

  // Initialize content
  const success = await initializeAppContent();

  if (success) {
    await launcherUpdateCheck;
    contentInitialized = true;
    if (shouldHoldStartupForLauncherUpdate()) {
      return;
    }
    await continueToAppContent();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  a0TagController?.dispose?.();
  if (hostGatewayQuitPending) return;
  hostGatewaySupervisor.stopAll('app_quit');
  if (!hostGatewaySupervisor.pendingStopCount()) return;
  hostGatewayQuitPending = true;
  event.preventDefault();
  void hostGatewaySupervisor.waitForStopped(8500).finally(() => app.quit());
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();

    if (contentInitialized) {
      // Content already initialized - load directly without update check
      // Verify content still exists before loading
      const hasContent = await checkExistingContent();
      if (hasContent) {
        if (!shouldHoldStartupForLauncherUpdate()) {
          await continueToAppContent();
        }
      } else {
        // Content was deleted - reinitialize
        contentInitialized = false;
        const success = await initializeAppContent();
        if (success) {
          contentInitialized = true;
          if (!shouldHoldStartupForLauncherUpdate()) {
            await continueToAppContent();
          }
        }
      }
    } else {
      // First activation or previous init failed - run full initialization
      const success = await initializeAppContent();

      if (success) {
        contentInitialized = true;
        if (!shouldHoldStartupForLauncherUpdate()) {
          await continueToAppContent();
        }
      }
    }
  }
});
