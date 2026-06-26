const { EventEmitter } = require('node:events');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { app } = require('electron');
const tarStream = require('tar-stream');
const yauzl = require('yauzl');

const { getDocker, resetDocker } = require('../docker_adapter/getDocker');
const releasesClient = require('./releases_client');
const stateStore = require('./state_store');
const retention = require('./retention');
const { toErrorResponse, mapDockerInterfaceErrorToUiMessage } = require('./errors');
const { isSemverReleaseTag } = require('./release_tags');
const { runtimeSetupProgressPatch } = require('./progress');

const DEFAULT_IMAGE_REPO = 'agent0ai/agent-zero';
const DEFAULT_GITHUB_REPO = 'agent0ai/agent-zero';
const CLONE_IMAGE_REPO = 'a0-launcher-clone';

const IMAGE_REPO_ENV_VAR = 'A0_BACKEND_IMAGE_REPO';
const GITHUB_REPO_ENV_VAR = 'A0_BACKEND_GITHUB_REPO';
const UI_READY_TIMEOUT_MS = 5 * 60_000;
const UI_READY_ATTEMPT_TIMEOUT_MS = 2_000;
const REMOTE_HEALTH_PATH = '/api/health';
const REMOTE_HEALTH_TIMEOUT_MS = 1_500;
const REMOTE_HEALTH_CACHE_TTL_MS = 30_000;
const CONTAINER_LOG_DEFAULT_LINES = 400;
const CONTAINER_LOG_MAX_LINES = 1500;
const CONTAINER_LOG_MAX_CHARS = 12_000;
const CONTAINER_SOURCE_MAX_BYTES = 256 * 1024;
const RUNTIME_SETUP_RESUME_ARG = '--a0-resume-runtime-setup';
const RUNTIME_SETUP_RUNONCE_VALUE = 'AgentZeroLauncherResumeRuntimeSetup';
const execFileAsync = promisify(execFile);
const AGENT_ZERO_CONTAINER_ROOT = '/a0';
const WORKSPACE_MOUNT_TARGET = '/a0/usr';
const STORAGE_MODE_HOST_DIRECTORY = 'host_directory';
const STORAGE_MODE_NAMED_VOLUME = 'named_volume';
const STORAGE_MODE_EPHEMERAL = 'ephemeral';
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const CLONE_WORKSPACE_CATEGORY_IDS = Object.freeze([
  'auth',
  'secrets',
  'providers',
  'mcp',
  'settings',
  'agents',
  'chats',
  'skills',
  'plugins',
  'projects',
  'memory',
  'files'
]);

const WORKSPACE_STORAGE_LABELS = Object.freeze({
  mode: 'a0.launcher.storage.mode',
  target: 'a0.launcher.storage.target',
  hostPath: 'a0.launcher.storage.hostPath',
  volumeName: 'a0.launcher.storage.volumeName',
  persistent: 'a0.launcher.storage.persistent',
  legacy: 'a0.launcher.storage.legacy'
});

const CLONE_RESERVED_PLUGIN_ENTRIES = Object.freeze(['_model_config', '_oauth']);
const CLONE_ENV_AUTH_KEYS = Object.freeze([
  'AUTH_LOGIN',
  'AUTH_PASSWORD',
  'ROOT_PASSWORD',
  'RFC_PASSWORD'
]);
const CLONE_ENV_SETTINGS_KEYS = Object.freeze([
  'DEFAULT_USER_TIMEZONE',
  'DEFAULT_USER_UTC_OFFSET_MINUTES'
]);
const CLONE_SETTINGS_FIELDS = Object.freeze({
  auth: Object.freeze([
    'auth_login',
    'auth_password',
    'root_password',
    'rfc_password'
  ]),
  secrets: Object.freeze([
    'api_keys',
    'secrets',
    'mcp_server_token'
  ]),
  providers: Object.freeze([
    'litellm_global_kwargs'
  ]),
  mcp: Object.freeze([
    'mcp_servers',
    'mcp_client_init_timeout',
    'mcp_client_tool_timeout',
    'mcp_server_enabled',
    'a2a_server_enabled'
  ]),
  settings: Object.freeze([
    'agent_profile',
    'agent_knowledge_subdir',
    'timezone',
    'time_format',
    'workdir_path',
    'workdir_show',
    'workdir_max_depth',
    'workdir_max_files',
    'workdir_max_folders',
    'workdir_max_lines',
    'workdir_gitignore',
    'file_browser_remember_last_directory',
    'rfc_auto_docker',
    'rfc_url',
    'rfc_port_http',
    'websocket_server_restart_enabled',
    'uvicorn_access_logs_enabled',
    'update_check_enabled',
    'chat_inherit_project',
    'variables'
  ])
});

const CHANNEL_TAGS = Object.freeze(['latest', 'ready', 'testing']);
const CANONICAL_LOCAL_TAGS = Object.freeze(['local', 'development', 'main']);
const CONTAINER_SOURCE_WORKDIRS = Object.freeze(['/a0', '/app', '/agent-zero']);
const remoteHealthCache = new Map();
const remoteHealthPending = new Map();

function logDockerManagerError(op, error, details = {}) {
  const payload = { ...details };
  if (error && typeof error === 'object') {
    if (error.code) payload.code = String(error.code);
    if (typeof error.message === 'string') payload.message = error.message;
    if (error.details && typeof error.details === 'object') payload.details = error.details;
    if (error.cause && typeof error.cause === 'object') payload.cause = error.cause;
  }
  try {
    console.error(`[docker-manager] ${op} failed`, payload);
  } catch {
    try {
      console.error(`[docker-manager] ${op} failed`);
    } catch {
      // ignore
    }
  }
}

function quoteWindowsCommandArg(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function runtimeResumeDefaultAppArg(argv = []) {
  if (!Array.isArray(argv)) return '';
  for (const arg of argv.slice(1)) {
    const value = String(arg || '').trim();
    if (!value || value.startsWith('-')) continue;
    return value;
  }
  return '';
}

function runtimeResumeLaunchCommand() {
  const parts = [quoteWindowsCommandArg(process.execPath)];
  const defaultAppArg = process.defaultApp ? runtimeResumeDefaultAppArg(process.argv) : '';
  if (defaultAppArg) {
    parts.push(quoteWindowsCommandArg(defaultAppArg));
  }
  parts.push(RUNTIME_SETUP_RESUME_ARG);
  return parts.join(' ');
}

async function registerRuntimeSetupRunOnce() {
  if (process.platform !== 'win32') return;
  await execFileAsync('reg.exe', [
    'add',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
    '/v',
    RUNTIME_SETUP_RUNONCE_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    runtimeResumeLaunchCommand(),
    '/f'
  ]).catch((error) => {
    logDockerManagerError('runtimeSetup.registerRunOnce', error);
  });
}

async function clearRuntimeSetupRunOnce() {
  if (process.platform !== 'win32') return;
  await execFileAsync('reg.exe', [
    'delete',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
    '/v',
    RUNTIME_SETUP_RUNONCE_VALUE,
    '/f'
  ]).catch(() => {});
}

async function markRuntimeSetupResume(assessment = null) {
  await stateStore.writeRuntimeSetupResume({
    reason: typeof assessment?.mode === 'string' ? assessment.mode : ''
  });
  if (assessment?.requiresRestart === true) {
    await registerRuntimeSetupRunOnce();
  }
}

async function clearRuntimeSetupResume() {
  await stateStore.clearRuntimeSetupResume().catch(() => false);
  await clearRuntimeSetupRunOnce();
}

function normalizeRepo(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return v;
  return '';
}

function getBackendImageRepo() {
  const fromEnv = normalizeRepo(process.env[IMAGE_REPO_ENV_VAR]);
  if (fromEnv) return fromEnv;
  return DEFAULT_IMAGE_REPO;
}

function getBackendGithubRepo() {
  const fromEnv = normalizeRepo(process.env[GITHUB_REPO_ENV_VAR]);
  if (fromEnv) return fromEnv;
  return DEFAULT_GITHUB_REPO;
}

async function getRuntimeEndpointPreference() {
  return await stateStore.readRuntimeEndpointPreference().catch(() => null);
}

async function getManagedDocker(imageRepo, options = {}) {
  return await getDocker({
    imageRepo,
    forceRefresh: !!options.forceRefresh,
    runtimePreference: await getRuntimeEndpointPreference()
  });
}

function isSafeTag(tag) {
  const t = (tag || '').trim();
  if (!t) return false;
  if (t.length > 128) return false;
  // Avoid separators that could form repo refs or paths.
  if (t.includes(':') || t.includes('/') || /\s/.test(t)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(t);
}

function isTestingTag(tag) {
  return (tag || '').trim() === 'testing';
}

function isLatestTag(tag) {
  return (tag || '').trim() === 'latest';
}

function isReadyTag(tag) {
  return (tag || '').trim() === 'ready';
}

function isChannelTag(tag) {
  return isLatestTag(tag) || isReadyTag(tag) || isTestingTag(tag);
}

function isVisibleChannelTag(tag) {
  return isLatestTag(tag) || isReadyTag(tag);
}

function isCanonicalLocalTag(tag) {
  const t = (tag || '').trim();
  return CANONICAL_LOCAL_TAGS.includes(t);
}

function assertTagAllowedForInstall(tag) {
  const t = (tag || '').trim();
  if (!isSafeTag(t)) {
    const err = new Error('Invalid tag');
    err.code = 'INVALID_TAG';
    throw err;
  }
  if (!isChannelTag(t) && !isSemverReleaseTag(t) && !isCanonicalLocalTag(t)) {
    const err = new Error('Tag not allowed for install');
    err.code = 'TAG_NOT_ALLOWED';
    throw err;
  }
  return t;
}

function assertTagAllowedForActivate(tag) {
  const t = (tag || '').trim();
  if (!isSafeTag(t)) {
    const err = new Error('Invalid tag');
    err.code = 'INVALID_TAG';
    throw err;
  }
  // Activate may target installed local builds; keep validation lightweight here.
  return t;
}

function imageRefForTag(imageRepo, tag) {
  return `${imageRepo}:${tag}`;
}

function splitImageAndTag(imageValue, tagValue) {
  let image = String(imageValue || '').trim();
  let tag = String(tagValue || '').trim();
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  let embeddedTag = '';
  if (lastColon > lastSlash) {
    embeddedTag = image.slice(lastColon + 1).trim();
    image = image.slice(0, lastColon).trim();
  }
  return { image, tag: tag || embeddedTag || 'latest' };
}

function sanitizeGitBranchName(value) {
  const branch = String(value || '').trim();
  if (!branch || branch === 'HEAD' || branch.length > 120) return '';
  if (/[\0-\x20\x7F]/.test(branch)) return '';
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return '';
  if (branch.includes('..') || branch.includes('@{') || branch.includes('\\')) return '';
  return branch;
}

function sanitizeGitCommit(value) {
  const commit = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(commit) ? commit : '';
}

function parseGitHead(text) {
  const line = String(text || '').split(/\r?\n/u).map((item) => item.trim()).find(Boolean) || '';
  if (!line) return null;

  if (line.startsWith('ref:')) {
    const refPath = line.slice(4).trim();
    const branch = refPath.startsWith('refs/heads/') ? sanitizeGitBranchName(refPath.slice('refs/heads/'.length)) : '';
    return { refPath, branch, commit: '' };
  }

  const commit = sanitizeGitCommit(line);
  return commit ? { refPath: '', branch: '', commit } : null;
}

function safeGitRefPath(value) {
  const refPath = String(value || '').trim();
  if (!refPath || refPath.length > 240) return '';
  if (!refPath.startsWith('refs/')) return '';
  if (/[\0-\x20\x7F]/.test(refPath)) return '';
  if (refPath.startsWith('/') || refPath.endsWith('/') || refPath.includes('//')) return '';
  if (refPath.includes('..') || refPath.includes('@{') || refPath.includes('\\')) return '';
  return refPath;
}

function parsePackedRefs(text, refPath) {
  const safeRef = safeGitRefPath(refPath);
  if (!safeRef) return '';

  for (const line of String(text || '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
    const parts = trimmed.split(/\s+/u);
    if (parts.length < 2) continue;
    if (parts[1] === safeRef) {
      const commit = sanitizeGitCommit(parts[0]);
      if (commit) return commit;
    }
  }

  return '';
}

function parseGitDirFile(text, workdir) {
  const line = String(text || '').split(/\r?\n/u).map((item) => item.trim()).find(Boolean) || '';
  const match = /^gitdir:\s*(.+)$/i.exec(line);
  if (!match) return '';

  const raw = match[1].trim();
  if (!raw || /[\0\r\n]/.test(raw)) return '';
  const candidate = raw.startsWith('/') ? raw : path.posix.join(workdir, raw);
  const normalized = path.posix.normalize(candidate);
  if (!normalized.startsWith('/')) return '';
  return normalized;
}

async function readContainerGitText(docker, containerId, filePath, maxBytes = CONTAINER_SOURCE_MAX_BYTES) {
  if (!docker || typeof docker.readContainerTextFile !== 'function') return null;
  try {
    return await docker.readContainerTextFile(containerId, filePath, { maxBytes });
  } catch {
    return null;
  }
}

async function inspectContainerRuntimeSource(docker, container) {
  const containerId = typeof container?.containerId === 'string' ? container.containerId.trim() : '';
  if (!containerId) return null;

  for (const workdir of CONTAINER_SOURCE_WORKDIRS) {
    let gitDir = `${workdir}/.git`;
    let headText = await readContainerGitText(docker, containerId, `${gitDir}/HEAD`, 8192);

    if (!headText) {
      const gitFile = await readContainerGitText(docker, containerId, `${workdir}/.git`, 8192);
      const redirectedGitDir = parseGitDirFile(gitFile, workdir);
      if (redirectedGitDir) {
        gitDir = redirectedGitDir;
        headText = await readContainerGitText(docker, containerId, `${gitDir}/HEAD`, 8192);
      }
    }

    const head = parseGitHead(headText);
    if (!head) continue;

    let commit = head.commit;
    const refPath = safeGitRefPath(head.refPath);
    if (!commit && refPath) {
      commit = sanitizeGitCommit(await readContainerGitText(docker, containerId, `${gitDir}/${refPath}`, 8192));
      if (!commit) {
        commit = parsePackedRefs(await readContainerGitText(docker, containerId, `${gitDir}/packed-refs`, CONTAINER_SOURCE_MAX_BYTES), refPath);
      }
    }

    const branch = sanitizeGitBranchName(head.branch);
    if (!branch && !commit) continue;

    return {
      type: 'git',
      workdir,
      branch: branch || null,
      commit: commit || null,
      shortCommit: commit ? commit.slice(0, 12) : null
    };
  }

  return null;
}

async function enrichContainersWithRuntimeSource(docker, containers) {
  const list = Array.isArray(containers) ? containers : [];
  if (!list.length || !docker || typeof docker.readContainerTextFile !== 'function') return list;

  return await Promise.all(list.map(async (container) => {
    const source = await inspectContainerRuntimeSource(docker, container);
    if (!source) return container;

    return {
      ...container,
      runtimeSource: source,
      runtimeBranch: source.branch || null,
      runtimeCommit: source.commit || null,
      runtimeShortCommit: source.shortCommit || null
    };
  }));
}

function assertCustomImageRepo(value) {
  const repo = String(value || '').trim().toLowerCase();
  const invalid = () => {
    const err = new Error('Invalid image name');
    err.code = 'INVALID_IMAGE';
    throw err;
  };

  if (!repo || repo.length > 255) invalid();
  if (/[\s@]/.test(repo) || /^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) invalid();
  if (repo.startsWith('/') || repo.endsWith('/') || repo.includes('//')) invalid();

  const parts = repo.split('/');
  if (!parts.length || parts.length > 8) invalid();
  const componentPattern = /^[a-z0-9]+(?:(?:[._-]+)[a-z0-9]+)*$/;
  const firstPattern = /^[a-z0-9]+(?:(?:[._-]+)[a-z0-9]+)*(?::[0-9]{1,5})?$/;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) invalid();
    if (i === 0 && part.includes(':')) {
      if (!firstPattern.test(part)) invalid();
      const port = Number(part.slice(part.lastIndexOf(':') + 1));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) invalid();
      continue;
    }
    if (!componentPattern.test(part)) invalid();
  }

  return repo;
}

function assertCustomImageTag(value) {
  const tag = String(value || 'latest').trim();
  if (!isSafeTag(tag)) {
    const err = new Error('Invalid image tag');
    err.code = 'INVALID_TAG';
    throw err;
  }
  return tag;
}

function assertCustomImageSpec(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  const split = splitImageAndTag(raw.image, raw.tag);
  const imageRepo = assertCustomImageRepo(split.image);
  const tag = assertCustomImageTag(split.tag);
  return {
    imageRepo,
    tag,
    imageRef: imageRefForTag(imageRepo, tag)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneWorkspaceDefaultSelection() {
  return Object.fromEntries(CLONE_WORKSPACE_CATEGORY_IDS.map((id) => [id, true]));
}

function normalizeCloneWorkspaceSelection(raw = null) {
  const defaults = cloneWorkspaceDefaultSelection();
  if (raw === null || raw === undefined || raw === true) return defaults;
  if (raw === false) {
    return Object.fromEntries(CLONE_WORKSPACE_CATEGORY_IDS.map((id) => [id, false]));
  }

  let source = null;
  if (Array.isArray(raw)) {
    source = Object.fromEntries(raw.map((id) => [id, true]));
  } else if (isPlainObject(raw?.workspaceCategories)) {
    source = raw.workspaceCategories;
  } else if (Array.isArray(raw?.workspaceCategories)) {
    source = Object.fromEntries(raw.workspaceCategories.map((id) => [id, true]));
  } else if (isPlainObject(raw)) {
    source = raw;
  }

  if (!source) return defaults;
  const out = {};
  for (const id of CLONE_WORKSPACE_CATEGORY_IDS) {
    out[id] = source[id] === true || source[id] === 'true' || source[id] === 1;
  }
  return out;
}

function selectedCloneWorkspaceCategoryIds(selection) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  return CLONE_WORKSPACE_CATEGORY_IDS.filter((id) => normalized[id] === true);
}

function cloneWorkspaceSelectionIsAll(selection) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  return CLONE_WORKSPACE_CATEGORY_IDS.every((id) => normalized[id] === true);
}

function cloneWorkspaceSelectionIsEmpty(selection) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  return CLONE_WORKSPACE_CATEGORY_IDS.every((id) => normalized[id] !== true);
}

function cloneWorkspaceSelectionLabel(selection) {
  return selectedCloneWorkspaceCategoryIds(selection).join(',');
}

function cloneSettingsFieldsForSelection(selection) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  const fields = new Set();
  for (const [category, categoryFields] of Object.entries(CLONE_SETTINGS_FIELDS)) {
    if (!normalized[category]) continue;
    for (const field of categoryFields) fields.add(field);
  }
  return fields;
}

function envLineKey(line) {
  const match = String(line || '').match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : '';
}

function cloneEnvKeyAllowed(key, selection) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  if (normalized.auth && CLONE_ENV_AUTH_KEYS.includes(key)) return true;
  if (normalized.settings && (CLONE_ENV_SETTINGS_KEYS.includes(key) || key.startsWith('A0_SET_'))) return true;
  if (normalized.secrets) {
    if (key.startsWith('API_KEY_')) return true;
    if (/_?(?:TOKEN|SECRET|KEY|PAT)$/i.test(key)) return true;
    if (/(?:TOKEN|SECRET|API_KEY|PAT)/i.test(key)) return true;
  }
  return false;
}

function filterEnvTextForClone(text, selection) {
  const lines = String(text || '').split(/\r?\n/u);
  const out = [];
  for (const line of lines) {
    const key = envLineKey(line);
    if (!key) continue;
    if (cloneEnvKeyAllowed(key, selection)) out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

function filterSettingsJsonForClone(text, selection) {
  const fields = cloneSettingsFieldsForSelection(selection);
  if (!fields.size) return '';
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || '{}'));
  } catch {
    return '';
  }
  if (!isPlainObject(parsed)) return '';
  const out = {};
  if (Object.prototype.hasOwnProperty.call(parsed, 'version')) out.version = parsed.version;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) out[field] = parsed[field];
  }
  return Object.keys(out).length ? `${JSON.stringify(out, null, 4)}\n` : '';
}

function isoToMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeIsoString(value) {
  const ms = isoToMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function extractLocalDigest(repoDigests) {
  for (const d of Array.isArray(repoDigests) ? repoDigests : []) {
    if (typeof d !== 'string') continue;
    const idx = d.indexOf('@');
    if (idx === -1) continue;
    const digest = d.slice(idx + 1).trim();
    if (digest.startsWith('sha256:') && digest.length > 15) return digest;
  }
  return null;
}

function shortDigest(digest) {
  const d = (digest || '').trim();
  if (!d) return '';
  if (d.startsWith('sha256:') && d.length > 15) return d.slice('sha256:'.length, 'sha256:'.length + 12);
  return d.length > 12 ? d.slice(0, 12) : d;
}

function buildDigestHint(publishedDigest, localDigest) {
  const pub = shortDigest(publishedDigest);
  const loc = shortDigest(localDigest);
  if (!pub || !loc) return null;
  return `Published: ${pub} / Local: ${loc}`;
}

function releaseTagLabel(tag) {
  const t = String(tag || '').trim();
  return t.startsWith('v') ? t.slice(1) : t;
}

function matchedSemverReleaseTagForDigest(localDigest, knownRemoteDigests) {
  const digest = String(localDigest || '').trim();
  if (!digest) return '';
  const match = (Array.isArray(knownRemoteDigests) ? knownRemoteDigests : [])
    .find((d) => d?.digest === digest && isSemverReleaseTag(d?.tag));
  return match?.tag || '';
}

function matchedReleaseTagForLocalTag(tag, localByTag, knownRemoteDigests, latestReleaseTag) {
  const channelTag = String(tag || '').trim();
  if (!isChannelTag(channelTag)) return '';
  const img = localByTag instanceof Map ? localByTag.get(channelTag) : null;
  const localDigest = extractLocalDigest(img?.repoDigests);
  const matchedReleaseTag = matchedSemverReleaseTagForDigest(localDigest, knownRemoteDigests);
  if (matchedReleaseTag) return matchedReleaseTag;
  if (channelTag === 'latest' && latestReleaseTag) {
    if (img && !localDigest) return latestReleaseTag;
    if (!img && localByTag instanceof Map && localByTag.has(latestReleaseTag)) return latestReleaseTag;
  }
  return '';
}

async function bestEffortRemoteTagMetadata(docker, imageRepo, tag) {
  if (!isVisibleChannelTag(tag)) {
    return null;
  }
  if (!docker || typeof docker.getRemoteTagMetadata !== 'function') {
    return { tagUpdatedAt: null, tagMetadataCheckedAt: nowIso() };
  }
  try {
    const metadata = await docker.getRemoteTagMetadata(imageRepo, tag);
    if (!metadata?.exists) return null;
    return {
      tagUpdatedAt: normalizeIsoString(metadata.updatedAt || metadata.pushedAt),
      tagMetadataCheckedAt: nowIso()
    };
  } catch (error) {
    logDockerManagerError('inventory.getRemoteTagMetadata', error, { tag });
    return { tagUpdatedAt: null, tagMetadataCheckedAt: nowIso() };
  }
}

function tagFromImageRef(imageRef) {
  const raw = String(imageRef || '').trim();
  if (!raw) return '';
  const lastSlash = raw.lastIndexOf('/');
  const lastColon = raw.lastIndexOf(':');
  return lastColon > lastSlash ? raw.slice(lastColon + 1).trim() : '';
}

function imageTagForContainer(container) {
  const labels = isPlainObject(container?.labels) ? container.labels : {};
  return String(
    container?.versionTag ||
    labels['a0.launcher.versionTag'] ||
    container?.tag ||
    tagFromImageRef(container?.imageRef) ||
    ''
  ).trim();
}

function applyContainerMatchedReleaseTags(containers, matchedReleaseTagByTag) {
  const matches = matchedReleaseTagByTag instanceof Map ? matchedReleaseTagByTag : new Map();
  return (Array.isArray(containers) ? containers : []).map((container) => {
    const imageTag = imageTagForContainer(container);
    const matchedReleaseTag = imageTag ? matches.get(imageTag) : '';
    if (!matchedReleaseTag) return container;
    return { ...container, matchedReleaseTag };
  });
}

function normalizeStorageMode(value, fallback = STORAGE_MODE_HOST_DIRECTORY) {
  const mode = String(value || '').trim();
  if (
    mode === STORAGE_MODE_HOST_DIRECTORY ||
    mode === STORAGE_MODE_NAMED_VOLUME ||
    mode === STORAGE_MODE_EPHEMERAL
  ) return mode;
  if (fallback === '') return '';
  return fallback === STORAGE_MODE_NAMED_VOLUME ? STORAGE_MODE_NAMED_VOLUME : STORAGE_MODE_HOST_DIRECTORY;
}

function expandHomePath(value) {
  const raw = String(value || '').trim() || stateStore.DEFAULT_STORAGE_PREFERENCES.hostRoot;
  if (raw === '~') return os.homedir() || raw;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = os.homedir();
    if (home) return path.join(home, raw.slice(2));
  }
  return raw;
}

function normalizeHostRootForUse(value) {
  const expanded = expandHomePath(value);
  return path.resolve(expanded);
}

function windowsPathToWslMountSource(value) {
  const input = String(value || '').trim();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (!match) return '';
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/[\\/]+/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive}/${rest}`;
}

function dockerUsesWindowsWslEngine(docker) {
  const env = docker?.env && typeof docker.env === 'object' ? docker.env : null;
  if (env?.dockerFlavor === 'wsl_engine') return true;
  const host = env?.dockerHost;
  return host?.kind === 'tcp' && host.host === '127.0.0.1' && Number(host.port) === 23750;
}

function dockerMountSourceForHostPath(hostPath, docker) {
  const source = String(hostPath || '').trim();
  if (!source) return source;
  if (!dockerUsesWindowsWslEngine(docker)) return source;
  return windowsPathToWslMountSource(source) || source;
}

function dockerVolumeName(value, fallback = 'a0-launcher-workspace') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 128);
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(cleaned)) return cleaned;
  return fallback;
}

function workspaceSlug(instanceName, containerName) {
  const candidate = containerName || instanceName || 'agent-zero';
  return sanitizeInstanceName(candidate, 'agent-zero-workspace').slice(0, 96);
}

function normalizeStorageOverride(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawMode = typeof input.storageMode === 'string' && input.storageMode.trim()
    ? input.storageMode
    : typeof input.mode === 'string' && input.mode.trim()
      ? input.mode
      : '';
  const mode = rawMode ? normalizeStorageMode(rawMode) : '';
  const hostRoot = typeof input.hostRoot === 'string' && input.hostRoot.trim() ? input.hostRoot.trim().slice(0, 512) : '';
  const volumeName = typeof input.volumeName === 'string' && input.volumeName.trim()
    ? dockerVolumeName(input.volumeName.trim())
    : '';
  if (!mode && !hostRoot && !volumeName) return null;
  return { mode, hostRoot, volumeName };
}

async function resolveWorkspaceStorage(options = {}) {
  const preferences = stateStore.normalizeStoragePreferences(options.preferences);
  const override = normalizeStorageOverride(options.override);
  const mode = normalizeStorageMode(override?.mode, preferences.mode);
  const slug = workspaceSlug(options.instanceName, options.containerName);
  const storage = {
    mode,
    target: WORKSPACE_MOUNT_TARGET,
    persistent: true,
    legacy: false
  };

  if (mode === STORAGE_MODE_EPHEMERAL) {
    return {
      ...storage,
      persistent: false
    };
  }

  if (mode === STORAGE_MODE_NAMED_VOLUME) {
    storage.volumeName = dockerVolumeName(
      override?.volumeName || `${preferences.volumePrefix || 'a0-launcher'}-${slug}-usr`,
      `a0-launcher-${slug}-usr`
    );
    storage.mount = {
      Type: 'volume',
      Source: storage.volumeName,
      Target: WORKSPACE_MOUNT_TARGET
    };
    return storage;
  }

  const root = normalizeHostRootForUse(override?.hostRoot || preferences.hostRoot);
  storage.hostRoot = root;
  storage.hostPath = path.join(root, slug, 'usr');
  storage.mount = {
    Type: 'bind',
    Source: storage.hostPath,
    Target: WORKSPACE_MOUNT_TARGET
  };
  await fs.mkdir(storage.hostPath, { recursive: true });
  return storage;
}

function workspaceStorageLabels(storage) {
  const labels = {
    [WORKSPACE_STORAGE_LABELS.mode]: storage?.mode || '',
    [WORKSPACE_STORAGE_LABELS.target]: WORKSPACE_MOUNT_TARGET,
    [WORKSPACE_STORAGE_LABELS.persistent]: storage?.persistent === true ? 'true' : 'false',
    [WORKSPACE_STORAGE_LABELS.legacy]: storage?.legacy === true ? 'true' : 'false'
  };
  if (storage?.hostPath) labels[WORKSPACE_STORAGE_LABELS.hostPath] = storage.hostPath;
  if (storage?.volumeName) labels[WORKSPACE_STORAGE_LABELS.volumeName] = storage.volumeName;
  return labels;
}

function mountTargetsWorkspace(mount) {
  return String(mount?.Target || mount?.Destination || '').trim() === WORKSPACE_MOUNT_TARGET;
}

function bindTargetsWorkspace(bind) {
  const parts = String(bind || '').split(':');
  if (parts.length < 2) return false;
  return parts[1] === WORKSPACE_MOUNT_TARGET;
}

function stripWorkspaceMounts(hostConfig) {
  const next = { ...(hostConfig && typeof hostConfig === 'object' ? hostConfig : {}) };
  if (Array.isArray(next.Mounts)) next.Mounts = next.Mounts.filter((mount) => !mountTargetsWorkspace(mount));
  if (Array.isArray(next.Binds)) next.Binds = next.Binds.filter((bind) => !bindTargetsWorkspace(bind));
  return next;
}

function applyWorkspaceStorage(createOptions, storage, { skipIfCustom = false, docker = null } = {}) {
  if (!createOptions || !storage) return createOptions;
  const hostConfig = stripWorkspaceMounts(createOptions.HostConfig || {});
  if (skipIfCustom) {
    const sourceHostConfig = createOptions.HostConfig || {};
    const hasCustomWorkspaceMount =
      (Array.isArray(sourceHostConfig.Mounts) && sourceHostConfig.Mounts.some(mountTargetsWorkspace)) ||
      (Array.isArray(sourceHostConfig.Binds) && sourceHostConfig.Binds.some(bindTargetsWorkspace));
    if (hasCustomWorkspaceMount) {
      createOptions.Labels = {
        ...(createOptions.Labels || {}),
        [WORKSPACE_STORAGE_LABELS.target]: WORKSPACE_MOUNT_TARGET,
        [WORKSPACE_STORAGE_LABELS.persistent]: 'true',
        [WORKSPACE_STORAGE_LABELS.mode]: 'custom_mount'
      };
      return createOptions;
    }
  }

  if (storage.mount) {
    const mount = { ...storage.mount };
    if (String(mount.Type || '').toLowerCase() === 'bind') {
      mount.Source = dockerMountSourceForHostPath(mount.Source || storage.hostPath, docker);
    }
    hostConfig.Mounts = [
      ...(Array.isArray(hostConfig.Mounts) ? hostConfig.Mounts : []),
      mount
    ];
  }
  createOptions.HostConfig = hostConfig;
  createOptions.Labels = {
    ...(createOptions.Labels || {}),
    ...workspaceStorageLabels(storage)
  };
  return createOptions;
}

function workspaceStorageFromLabels(labels) {
  const source = labels && typeof labels === 'object' ? labels : {};
  const target = source[WORKSPACE_STORAGE_LABELS.target] || WORKSPACE_MOUNT_TARGET;
  const mode = normalizeStorageMode(source[WORKSPACE_STORAGE_LABELS.mode], '');
  const persistent = source[WORKSPACE_STORAGE_LABELS.persistent] === 'true';
  if (!persistent && source[WORKSPACE_STORAGE_LABELS.legacy] === 'true') {
    return {
      mode: 'legacy_ephemeral',
      target,
      persistent: false,
      legacy: true,
      migrationAvailable: true
    };
  }
  if (!persistent && !mode) return null;
  if (!persistent && mode === STORAGE_MODE_EPHEMERAL) {
    return {
      mode,
      target,
      persistent: false,
      legacy: false,
      hostPath: '',
      volumeName: '',
      migrationAvailable: true
    };
  }
  return {
    mode: mode || 'custom_mount',
    target,
    persistent,
    legacy: false,
    hostPath: source[WORKSPACE_STORAGE_LABELS.hostPath] || '',
    volumeName: source[WORKSPACE_STORAGE_LABELS.volumeName] || '',
    migrationAvailable: persistent === false
  };
}

function workspaceStorageFromInspect(inspect) {
  const labels = normalizeDockerLabels(inspect?.Config?.Labels);
  const fromLabels = workspaceStorageFromLabels(labels);
  const mounts = Array.isArray(inspect?.Mounts) ? inspect.Mounts : [];
  const mount = mounts.find((item) => String(item?.Destination || '').trim() === WORKSPACE_MOUNT_TARGET) || null;
  if (mount) {
    const type = String(mount.Type || '').toLowerCase();
    const mode = type === 'volume' ? STORAGE_MODE_NAMED_VOLUME : type === 'bind' ? STORAGE_MODE_HOST_DIRECTORY : fromLabels?.mode || 'custom_mount';
    return {
      mode,
      target: WORKSPACE_MOUNT_TARGET,
      persistent: true,
      legacy: false,
      hostPath: mode === STORAGE_MODE_HOST_DIRECTORY ? String(mount.Source || fromLabels?.hostPath || '') : '',
      volumeName: mode === STORAGE_MODE_NAMED_VOLUME ? String(mount.Name || mount.Source || fromLabels?.volumeName || '') : '',
      migrationAvailable: false
    };
  }
  if (fromLabels?.persistent) return fromLabels;
  if (fromLabels && fromLabels.mode === STORAGE_MODE_EPHEMERAL) return fromLabels;
  return {
    mode: 'legacy_ephemeral',
    target: WORKSPACE_MOUNT_TARGET,
    persistent: false,
    legacy: true,
    migrationAvailable: true
  };
}

function workspaceHostPathFromInspect(inspect) {
  const storage = workspaceStorageFromInspect(inspect);
  const hostPath = typeof storage?.hostPath === 'string' ? storage.hostPath.trim() : '';
  if (!storage?.persistent || !hostPath) return '';
  return path.resolve(hostPath);
}

async function enrichContainersWithWorkspaceStorage(docker, containers) {
  const out = [];
  for (const container of Array.isArray(containers) ? containers : []) {
    if (!container?.containerId) {
      out.push(container);
      continue;
    }
    try {
      const inspect = await docker.inspectContainer(container.containerId);
      out.push({ ...container, workspaceStorage: workspaceStorageFromInspect(inspect) });
    } catch {
      const labels = normalizeDockerLabels(container?.labels);
      const fromLabels = workspaceStorageFromLabels(labels);
      out.push({ ...container, workspaceStorage: fromLabels || null });
    }
  }
  return out;
}

function emptyDerivedState(runtime = null) {
  return {
    versions: [],
    retainedInstances: [],
    remoteInstances: [],
    retentionPolicy: { keepCount: 1 },
    portPreferences: { ui: 8880, ssh: 55022 },
    storagePreferences: { ...stateStore.DEFAULT_STORAGE_PREFERENCES },
    instanceDefaults: {
      models: {
        Main: { provider: 'openrouter', model: '', apiKey: '' },
        Utility: { provider: 'openrouter', model: '', apiKey: '' },
        Embedding: { provider: 'huggingface', model: '', apiKey: '' }
      }
    },
    uiUrl: null,
    lastSyncedAt: null,
    offline: false,
    storage: {
      dockerRootDir: null,
      freeBytes: null,
      usedBytes: null,
      estimateAfterUpdateBytes: null
    },
    runtime
  };
}

function normalizeRuntimeAssessment(assessment, env = null) {
  let state = typeof assessment?.state === 'string' ? assessment.state : 'unsupported';
  const detail = typeof assessment?.detail === 'string' ? assessment.detail : 'Automatic Runtime Setup is not available.';
  if (state === 'unsupported' && /user needs Docker access|not in the docker group/i.test(detail)) {
    state = 'needs_group_membership';
  }
  const actionByState = {
    not_provisioned: 'install',
    needs_group_membership: 'install',
    engine_stopped: 'start',
    manual_install: 'manual',
    unsupported: 'manual',
    needs_relogin: 'refresh',
    ready: ''
  };

  const runtime = {
    platform: process.platform,
    state,
    detail,
    dockerFlavor: typeof env?.dockerFlavor === 'string' ? env.dockerFlavor : null,
    dockerHost: typeof env?.dockerHost?.raw === 'string' ? env.dockerHost.raw : null,
    selectedRuntimeEndpointId: typeof env?.selectedRuntimeEndpointId === 'string' ? env.selectedRuntimeEndpointId : null,
    runtimeCandidates: Array.isArray(env?.runtimeCandidates) ? env.runtimeCandidates : [],
    canProvision: assessment?.canProvision === true || state === 'not_provisioned' || state === 'needs_group_membership' || state === 'engine_stopped',
    action: actionByState[state] || ''
  };

  if (typeof assessment?.mode === 'string') runtime.mode = assessment.mode;
  if (typeof assessment?.distro === 'string') runtime.distro = assessment.distro;
  if (typeof assessment?.requiresAdmin === 'boolean') runtime.requiresAdmin = assessment.requiresAdmin;
  if (typeof assessment?.requiresRestart === 'boolean') runtime.requiresRestart = assessment.requiresRestart;
  if (typeof assessment?.setupActionLabel === 'string') runtime.setupActionLabel = assessment.setupActionLabel;
  if (typeof assessment?.packageManager === 'string') runtime.packageManager = assessment.packageManager;
  if (Array.isArray(assessment?.manualPackages)) {
    runtime.manualPackages = assessment.manualPackages.filter((item) => typeof item === 'string');
  }
  if (typeof assessment?.manualCommand === 'string') runtime.manualCommand = assessment.manualCommand;
  if (typeof assessment?.manualUrl === 'string') runtime.manualUrl = assessment.manualUrl;

  return runtime;
}

function runtimeReadyAssessment(env = null) {
  return normalizeRuntimeAssessment({ state: 'ready', detail: 'Runtime is ready.' }, env);
}

async function getRuntimeProvisioner() {
  const { RuntimeProvisioner } = await import('../docker_adapter/RuntimeProvisioner.mjs');
  return await RuntimeProvisioner.forPlatform({
    managedDir: path.join(app.getPath('userData'), 'runtime')
  });
}

async function assessRuntime(env = null) {
  if (env?.dockerAvailable) {
    return runtimeReadyAssessment(env);
  }

  const provisioner = await getRuntimeProvisioner();
  if (!provisioner) {
    return normalizeRuntimeAssessment({
      state: 'unsupported',
      detail: 'Automatic Runtime Setup is not available on this system. Install Docker Desktop or Docker Engine, then refresh.'
    }, env);
  }

  try {
    const assessment = await provisioner.assess();
    return normalizeRuntimeAssessment(assessment, env);
  } catch (error) {
    return normalizeRuntimeAssessment({
      state: 'unsupported',
      detail: error?.message || 'Automatic Runtime Setup is not available on this system.'
    }, env);
  }
}

function runtimeDiagnosticsFromError(error, env = null) {
  return {
    checkedAt: new Date().toISOString(),
    reachable: false,
    dockerHost: typeof env?.dockerHost?.raw === 'string' ? env.dockerHost.raw : '',
    dockerHostKind: typeof env?.dockerHost?.kind === 'string' ? env.dockerHost.kind : '',
    dockerFlavor: typeof env?.dockerFlavor === 'string' ? env.dockerFlavor : '',
    diagnosticCode: typeof error?.code === 'string' ? error.code : (typeof env?.diagnosticCode === 'string' ? env.diagnosticCode : null),
    diagnosticMessage: mapDockerInterfaceErrorToUiMessage(error) || error?.message || env?.diagnosticMessage || 'Docker runtime diagnostics are unavailable.'
  };
}

async function collectRuntimeDiagnostics(docker, env = null) {
  if (!docker || typeof docker.getRuntimeDiagnostics !== 'function') {
    return {
      checkedAt: new Date().toISOString(),
      reachable: !!env?.dockerAvailable,
      dockerHost: typeof env?.dockerHost?.raw === 'string' ? env.dockerHost.raw : '',
      dockerHostKind: typeof env?.dockerHost?.kind === 'string' ? env.dockerHost.kind : '',
      dockerFlavor: typeof env?.dockerFlavor === 'string' ? env.dockerFlavor : '',
      diagnosticCode: typeof env?.diagnosticCode === 'string' ? env.diagnosticCode : null,
      diagnosticMessage: typeof env?.diagnosticMessage === 'string' ? env.diagnosticMessage : null
    };
  }

  try {
    return await docker.getRuntimeDiagnostics();
  } catch (error) {
    return runtimeDiagnosticsFromError(error, env);
  }
}

async function buildUnavailableState(runtime) {
  const [retentionPolicy, portPreferences, storagePreferences, instanceDefaults, remoteInstances] = await Promise.all([
    stateStore.readRetentionPolicy().catch(() => ({ keepCount: 1 })),
    stateStore.readPortPreferences().catch(() => ({ ui: 8880, ssh: 55022 })),
    stateStore.readStoragePreferences().catch(() => ({ ...stateStore.DEFAULT_STORAGE_PREFERENCES })),
    stateStore.readInstanceDefaults().catch(() => null),
    stateStore.readRemoteInstances().catch(() => [])
  ]);
  const empty = emptyDerivedState(runtime);
  return {
    ...empty,
    retentionPolicy,
    portPreferences,
    storagePreferences,
    instanceDefaults: instanceDefaults || empty.instanceDefaults,
    remoteInstances: enrichRemoteInstancesWithHealth(remoteInstances)
  };
}

function bestEffortUiUrlFromInspect(inspect) {
  const ports = inspect?.NetworkSettings?.Ports;
  if (!ports || typeof ports !== 'object') return null;

  /** @type {{containerPort: number, hostPort: number}[]} */
  const candidates = [];
  for (const [containerPortSpec, bindings] of Object.entries(ports)) {
    const containerPort = Number(String(containerPortSpec || '').split('/')[0]);
    if (!Number.isFinite(containerPort) || containerPort <= 0 || containerPort > 65535) continue;
    for (const b of Array.isArray(bindings) ? bindings : []) {
      const hostPort = Number(b?.HostPort);
      if (!Number.isFinite(hostPort) || hostPort <= 0 || hostPort > 65535) continue;
      candidates.push({ containerPort, hostPort });
    }
  }

  if (!candidates.length) return null;

  // Prefer typical HTTP ports first. Agent Zero currently exposes 80/tcp.
  const preferredContainerPorts = [80, 7860, 3000, 8080, 5000, 9000, 9001, 9002];
  for (const p of preferredContainerPorts) {
    const match = candidates.find((c) => c.containerPort === p);
    if (match) return `http://127.0.0.1:${match.hostPort}/`;
  }

  // Avoid SSH (22) as a UI target.
  candidates.sort((a, b) => a.hostPort - b.hostPort);
  const fallback = candidates.find((c) => c.containerPort !== 22) || candidates[0];
  return `http://127.0.0.1:${fallback.hostPort}/`;
}

function parseHostPortFromLocalUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = String(u.hostname || '').trim();
    if (!host) return null;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
    const port = Number(u.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host: host === 'localhost' ? '127.0.0.1' : host, port };
  } catch {
    return null;
  }
}

function isHttpPortReachable(host, port, timeoutMs) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return Promise.resolve(false);

  const hRaw = String(host || '').trim();
  const h = hRaw === 'localhost' || hRaw === '::1' ? '127.0.0.1' : hRaw;
  if (!h) return Promise.resolve(false);

  return new Promise((resolve) => {
    const req = http.request(
      {
        method: 'GET',
        hostname: h,
        port: p,
        path: '/',
        headers: {
          'User-Agent': 'A0-Launcher',
          'Accept': '*/*'
        }
      },
      (res) => {
        try {
          res.resume();
        } catch {
          // ignore
        }
        const status = Number(res.statusCode);
        resolve(Number.isFinite(status) && status > 0 && status < 500);
      }
    );
    req.once('error', () => resolve(false));
    req.setTimeout(Math.max(80, Math.floor(timeoutMs || 350)), () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      resolve(false);
    });
    req.end();
  });
}

function remoteHealthKey(remote = {}) {
  return `${String(remote?.id || '').trim()}\n${String(remote?.url || '').trim()}`;
}

function remoteHealthUrl(remoteUrl) {
  const url = new URL(String(remoteUrl || ''));
  const basePath = String(url.pathname || '/').replace(/\/+$/, '');
  url.pathname = `${basePath || ''}${REMOTE_HEALTH_PATH}`;
  url.search = '';
  url.hash = '';
  return url;
}

function remoteHealthSnapshot(entry = null, fallbackStatus = 'checking') {
  const status = entry?.status === 'online' || entry?.status === 'offline' || entry?.status === 'checking'
    ? entry.status
    : fallbackStatus;
  const out = { status };
  if (typeof entry?.checkedAt === 'string') out.checkedAt = entry.checkedAt;
  if (typeof entry?.error === 'string' && entry.error) out.error = entry.error.slice(0, 160);
  return out;
}

function requestRemoteHealth(url, timeoutMs = REMOTE_HEALTH_TIMEOUT_MS) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url || ''));
  } catch {
    return Promise.resolve({ online: false, error: 'Invalid remote health URL' });
  }

  const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
  if (!transport) return Promise.resolve({ online: false, error: 'Unsupported remote health URL' });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = transport.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'A0-Launcher',
          'Accept': 'application/json,*/*'
        }
      },
      (res) => {
        try {
          res.resume();
        } catch {
          // ignore
        }
        const status = Number(res.statusCode);
        finish({
          online: Number.isFinite(status) && status >= 200 && status < 400,
          statusCode: Number.isFinite(status) ? status : null,
          error: Number.isFinite(status) && status >= 400 ? `HTTP ${status}` : ''
        });
      }
    );
    req.once('error', (error) => {
      finish({ online: false, error: error?.code || error?.message || 'Health check failed' });
    });
    req.setTimeout(Math.max(250, Math.floor(timeoutMs || REMOTE_HEALTH_TIMEOUT_MS)), () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      finish({ online: false, error: 'Health check timed out' });
    });
    req.end();
  });
}

async function probeRemoteHealth(remote = {}) {
  const key = remoteHealthKey(remote);
  try {
    const healthUrl = remoteHealthUrl(remote?.url || '');
    const result = await requestRemoteHealth(healthUrl, REMOTE_HEALTH_TIMEOUT_MS);
    const entry = {
      status: result?.online ? 'online' : 'offline',
      checkedAt: new Date().toISOString(),
      error: result?.online ? '' : String(result?.error || 'Health check failed').slice(0, 160)
    };
    remoteHealthCache.set(key, entry);
    return entry;
  } catch (error) {
    const entry = {
      status: 'offline',
      checkedAt: new Date().toISOString(),
      error: error?.message || 'Health check failed'
    };
    remoteHealthCache.set(key, entry);
    return entry;
  } finally {
    remoteHealthPending.delete(key);
  }
}

function enrichRemoteInstancesWithHealth(remoteInstances = [], options = {}) {
  const remotes = Array.isArray(remoteInstances) ? remoteInstances : [];
  const now = Date.now();
  const forceRefresh = options?.forceRefresh === true;
  return remotes.map((remote) => {
    const key = remoteHealthKey(remote);
    const cached = remoteHealthCache.get(key) || null;
    const checkedAtMs = isoToMs(cached?.checkedAt);
    const fresh = !forceRefresh && Number.isFinite(checkedAtMs) && now - checkedAtMs < REMOTE_HEALTH_CACHE_TTL_MS;
    const pending = remoteHealthPending.has(key);
    if ((!cached || !fresh) && !pending) {
      const pendingProbe = probeRemoteHealth(remote)
        .then(() => {
          if (_cachedState?.remoteInstances) {
            _cachedState = {
              ..._cachedState,
              remoteInstances: enrichRemoteInstancesWithHealth(_cachedState.remoteInstances)
            };
            events.emit('state', _cachedState);
          }
        })
        .catch(() => {});
      remoteHealthPending.set(key, pendingProbe);
    }

    return {
      ...remote,
      health: remoteHealthSnapshot(cached, cached ? cached.status : 'checking')
    };
  });
}

async function waitForHttpPort(host, port, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60_000;
  const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 450;
  const attemptTimeoutMs =
    Number.isFinite(Number(options.attemptTimeoutMs)) ? Number(options.attemptTimeoutMs) : UI_READY_ATTEMPT_TIMEOUT_MS;
  const onTick = typeof options.onTick === 'function' ? options.onTick : null;

  const startedAt = Date.now();
  let lastTickSeconds = -1;

  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isHttpPortReachable(host, port, attemptTimeoutMs);
    if (ok) return true;

    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (onTick && seconds !== lastTickSeconds) {
      lastTickSeconds = seconds;
      try {
        onTick(seconds);
      } catch {
        // ignore
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (onTick) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    try {
      onTick(seconds);
    } catch {
      // ignore
    }
  }

  return false;
}

async function waitForUiReachable(docker, containerId, options = {}) {
  try {
    const inspect = await docker.inspectContainer(containerId);
    const uiUrl = bestEffortUiUrlFromInspect(inspect);
    const hp = parseHostPortFromLocalUrl(uiUrl);
    if (!hp) return { uiUrl: null, ok: false };
    const ok = await waitForHttpPort(hp.host, hp.port, options);
    return { uiUrl, ok };
  } catch {
    return { uiUrl: null, ok: false };
  }
}

function computeImageBytesStats(localImages) {
  const byId = new Map();
  let maxImageBytes = 0;

  for (const img of localImages || []) {
    const id = typeof img?.imageId === 'string' ? img.imageId : '';
    const size = Number(img?.sizeBytes);
    if (!id) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    const prev = byId.get(id) || 0;
    const next = size > prev ? size : prev;
    byId.set(id, next);
    if (next > maxImageBytes) maxImageBytes = next;
  }

  if (!byId.size) return { usedBytes: null, maxImageBytes: null };

  let usedBytes = 0;
  for (const v of byId.values()) usedBytes += v;
  return {
    usedBytes: Number.isFinite(usedBytes) ? Math.floor(usedBytes) : null,
    maxImageBytes: Number.isFinite(maxImageBytes) && maxImageBytes > 0 ? Math.floor(maxImageBytes) : null
  };
}

function applyLocalInstanceIdentity(containers, localInstanceNames, localInstanceColors, localInstanceCredentials) {
  const names = isPlainObject(localInstanceNames) ? localInstanceNames : {};
  const colors = isPlainObject(localInstanceColors) ? localInstanceColors : {};
  const credentials = isPlainObject(localInstanceCredentials) ? localInstanceCredentials : {};
  return (Array.isArray(containers) ? containers : []).map((container) => {
    const id = typeof container?.containerId === 'string' ? container.containerId : '';
    const override = id && typeof names[id] === 'string' ? names[id] : '';
    const color = id && typeof colors[id] === 'string' ? colors[id] : '';
    const credential = id && isPlainObject(credentials[id]) && credentials[id].saved ? credentials[id] : null;
    if (!override && !color && !credential) return container;
    return {
      ...container,
      ...(override ? { instanceName: override } : {}),
      ...(color ? { instanceColor: color } : {}),
      ...(credential
        ? {
            launcherCredentials: {
              saved: true,
              username: typeof credential.username === 'string' ? credential.username : '',
              updatedAt: typeof credential.updatedAt === 'string' ? credential.updatedAt : ''
            }
          }
        : {})
    };
  });
}

async function bestEffortFreeBytesForUserData() {
  try {
    if (typeof fs.statfs !== 'function') return null;
    const dir = app.getPath('userData');
    const s = await fs.statfs(dir);
    const bsize = Number(s?.bsize);
    const bavail = Number(s?.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail)) return null;
    const freeBytes = bsize * bavail;
    return Number.isFinite(freeBytes) ? Math.max(0, Math.floor(freeBytes)) : null;
  } catch {
    return null;
  }
}

function estimateAfterUpdateBytes(freeBytes, latestReleaseTag, localByTag, imageStats) {
  if (!Number.isFinite(Number(freeBytes))) return null;
  if (!latestReleaseTag) return null;
  if (localByTag && localByTag.has(latestReleaseTag)) return Math.max(0, Math.floor(Number(freeBytes)));

  const maxImageBytes = imageStats?.maxImageBytes;
  if (!Number.isFinite(Number(maxImageBytes))) return null;
  const estimate = Number(freeBytes) - Number(maxImageBytes);
  return Number.isFinite(estimate) ? Math.max(0, Math.floor(estimate)) : null;
}

const events = new EventEmitter();
events.setMaxListeners(50);

let _cachedState = null;
let _currentOperation = null;
const _abortControllers = new Map();
const _warmLayerSizes = { running: false, lastImageRepo: '', lastStartedAtMs: 0 };
const _backgroundOperations = new Map();
const _containerOperationChains = new Map();

function backgroundOperationsSnapshot() {
  return Array.from(_backgroundOperations.values()).map((op) => ({ ...op }));
}

function stateWithBackgroundOperations(state = null) {
  const base = state && typeof state === 'object' ? state : {};
  return { ...base, backgroundOperations: backgroundOperationsSnapshot() };
}

function emitBackgroundOperationsState() {
  if (!_cachedState) return;
  _cachedState = stateWithBackgroundOperations(_cachedState);
  events.emit('state', _cachedState);
}

function updateBackgroundOperation(opId, patch = {}) {
  const current = _backgroundOperations.get(opId);
  if (!current) return null;
  const next = { ...current, ...(patch || {}) };
  _backgroundOperations.set(opId, next);
  emitBackgroundOperationsState();
  return next;
}

function finishBackgroundOperation(opId, status, error = null) {
  const errorMessage = error
    ? mapDockerInterfaceErrorToUiMessage(error) || error?.message || 'Operation failed'
    : '';
  updateBackgroundOperation(opId, {
    status,
    finishedAt: nowIso(),
    message: status === 'failed' ? errorMessage : '',
    error: errorMessage || null,
    errorCode: error?.code || null
  });
}

function pruneBackgroundOperation(opId) {
  if (!_backgroundOperations.delete(opId)) return;
  emitBackgroundOperationsState();
}

function enqueueContainerOperation({ type, containerId, message, run }) {
  const id = assertContainerId(containerId);
  if (typeof run !== 'function') {
    const err = new Error('Invalid operation');
    err.code = 'INVALID_OPERATION';
    throw err;
  }

  const opId = `bg_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  _backgroundOperations.set(opId, {
    opId,
    type,
    status: 'queued',
    containerId: id,
    queuedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    message: message || '',
    error: null,
    errorCode: null
  });
  emitBackgroundOperationsState();

  const previous = _containerOperationChains.get(id) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      updateBackgroundOperation(opId, {
        status: 'running',
        startedAt: nowIso(),
        message: message || ''
      });
      try {
        await run(id);
        finishBackgroundOperation(opId, 'completed');
      } catch (error) {
        finishBackgroundOperation(opId, 'failed', error);
      } finally {
        refreshDockerManager({ forceRefresh: false }).catch(() => {});
        setTimeout(() => {
          pruneBackgroundOperation(opId);
        }, 2000);
      }
    });

  const trackedTask = task.finally(() => {
    if (_containerOperationChains.get(id) === trackedTask) {
      _containerOperationChains.delete(id);
    }
  });
  _containerOperationChains.set(id, trackedTask);

  return { opId, queued: true, background: true };
}

function scheduleLayerSizesWarmup(docker, imageRepo, tags) {
  const repo = (imageRepo || '').trim();
  if (!repo) return;

  if (_warmLayerSizes.running) return;
  const nowMs = Date.now();
  if (_warmLayerSizes.lastImageRepo === repo && Number.isFinite(_warmLayerSizes.lastStartedAtMs) && nowMs - _warmLayerSizes.lastStartedAtMs < 10 * 60 * 1000) {
    return;
  }

  _warmLayerSizes.running = true;
  _warmLayerSizes.lastImageRepo = repo;
  _warmLayerSizes.lastStartedAtMs = nowMs;

  setTimeout(() => {
    (async () => {
      if (_currentOperation && _currentOperation.status === 'running') return;

      const seen = new Set();
      const ordered = [];
      for (const t of tags || []) {
        const s = (t || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        ordered.push(s);
      }

      const limit = Math.min(25, ordered.length);
      for (let i = 0; i < limit; i += 1) {
        const tag = ordered[i];
        try {
          await docker.getRemoteLayerSizes(repo, tag, { os: 'linux' });
        } catch (error) {
          const code = error?.code || error?.details?.code || '';
          if (code === 'REGISTRY_RATE_LIMIT') break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })().catch(() => {}).finally(() => {
      _warmLayerSizes.running = false;
    });
  }, 0);
}

function getCurrentOperation() {
  return _currentOperation;
}

function requireNoRunningOperation() {
  if (_currentOperation && _currentOperation.status === 'running') {
    const err = new Error('Another operation is already running');
    err.code = 'OP_IN_PROGRESS';
    throw err;
  }
}

function beginOperation(type, targetTag, options = {}) {
  requireNoRunningOperation();
  const presentation = options?.presentation === 'toast' ? 'toast' : 'modal';
  const opId = `op_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  _currentOperation = {
    opId,
    type,
    presentation,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    targetTag: targetTag || null,
    progress: null,
    downloadProgress: null,
    extractProgress: null,
    message: null,
    headline: null,
    detail: null,
    phase: null,
    steps: null,
    indeterminate: false,
    canCancel: false,
    error: null,
    errorCode: null
  };
  events.emit('progress', { ..._currentOperation });
  return opId;
}

function updateOperationProgress(patch) {
  if (!_currentOperation) return;
  _currentOperation = { ..._currentOperation, ...(patch || {}) };
  events.emit('progress', { ..._currentOperation });
}

function finishOperation(status, errorMessage, errorCode = null) {
  if (!_currentOperation) return;
  _currentOperation = {
    ..._currentOperation,
    status,
    finishedAt: nowIso(),
    canCancel: false,
    indeterminate: false,
    error: errorMessage || null,
    errorCode: errorCode || null
  };
  events.emit('progress', { ..._currentOperation });
}

async function buildDerivedState(options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const imageRepo = getBackendImageRepo();
  const githubRepo = getBackendGithubRepo();

  const docker = await getManagedDocker(imageRepo, { forceRefresh });

  const env = await docker.getEnvironment();
  let runtime = await assessRuntime(env);
  let runtimeDiagnostics = null;
  if (!env?.dockerAvailable) {
    runtimeDiagnostics = await collectRuntimeDiagnostics(docker, env);
    if (runtimeDiagnostics?.reachable) {
      runtime = runtimeReadyAssessment(env);
    } else {
      return await buildUnavailableState(runtime);
    }
  }

  const [retentionPolicy, portPreferences, storagePreferences, instanceDefaults, remoteInstances, localInstanceNames, localInstanceColors, localInstanceCredentials, installabilityCache, releasesResult, localImages, rawContainers, freeBytes, remoteTags] =
    await Promise.all([
      stateStore.readRetentionPolicy(),
      stateStore.readPortPreferences(),
      stateStore.readStoragePreferences(),
      stateStore.readInstanceDefaults(),
      stateStore.readRemoteInstances(),
      stateStore.readLocalInstanceNames(),
      stateStore.readLocalInstanceColors(),
      stateStore.readLocalInstanceCredentialsMetadata(),
      stateStore.readInstallabilityCache(),
      releasesClient.listOfficialReleases({ githubRepo, forceRefresh }),
      docker.listLocalImages(imageRepo),
      docker.listContainers(imageRepo),
      bestEffortFreeBytesForUserData(),
      docker.listRemoteTags(imageRepo).catch(() => null)
    ]);
  let containers = applyLocalInstanceIdentity(
    await enrichContainersWithWorkspaceStorage(docker, await enrichContainersWithRuntimeSource(docker, rawContainers)),
    localInstanceNames,
    localInstanceColors,
    localInstanceCredentials
  );

  const releases = Array.isArray(releasesResult?.releases) ? releasesResult.releases : [];
  const offline = !!releasesResult?.offline;
  const lastSyncedAt = releasesResult?.lastSyncedAt || null;
  const remoteInstancesWithHealth = enrichRemoteInstancesWithHealth(remoteInstances, { forceRefresh });

  // Trim dead official releases: allow gaps, but once we see 2 missing in a row,
  // assume we've reached the tail where older tags are no longer available on Docker Hub.
  const remoteTagList = Array.isArray(remoteTags) ? remoteTags : [];
  const remoteTagSet = remoteTagList.length ? new Set(remoteTagList) : null;
  let releasesForUi = releases;
  if (remoteTagSet) {
    const trimmed = [];
    let missingStreak = 0;
    for (const r of releases) {
      const t = (r?.tag || '').trim();
      if (!t) continue;
      if (remoteTagSet.has(t)) {
        trimmed.push(r);
        missingStreak = 0;
        continue;
      }
      missingStreak += 1;
      if (missingStreak >= 2) break;
    }
    releasesForUi = trimmed;
  }

  const activeName = retention.getActiveContainerName(imageRepo);
  const activeContainer = (containers || []).find((c) => c && c.containerName === activeName) || null;
  const activeTag = activeContainer?.tag || null;
  const activeState = typeof activeContainer?.state === 'string' ? activeContainer.state : null;

  let uiUrl = null;
  if (activeContainer && activeContainer.containerId && String(activeState || '').toLowerCase() === 'running') {
    try {
      const inspect = await docker.inspectContainer(activeContainer.containerId);
      const candidate = bestEffortUiUrlFromInspect(inspect);
      if (candidate) {
        const hp = parseHostPortFromLocalUrl(candidate);
        if (hp) {
          const ok = await isHttpPortReachable(hp.host, hp.port, UI_READY_ATTEMPT_TIMEOUT_MS);
          uiUrl = ok ? candidate : null;
        }
      }
    } catch {
      // best-effort only
    }
  }

  const retainedInstances = [];
  for (const c of containers || []) {
    const name = c?.containerName || '';
    const parsed = retention.parseRetainedContainerName(name);
    if (!parsed) continue;
    retainedInstances.push({
      containerId: c?.containerId || '',
      containerName: name,
      versionTag: parsed.tag,
      retainedAt: parsed.retainedAt
    });
  }
  retainedInstances.sort((a, b) => {
    const ams = isoToMs(a.retainedAt);
    const bms = isoToMs(b.retainedAt);
    if (Number.isFinite(bms) && Number.isFinite(ams)) return bms - ams;
    return String(b.retainedAt).localeCompare(String(a.retainedAt));
  });

  const localByTag = new Map();
  for (const img of localImages || []) {
    const tag = (img?.tag || '').trim();
    if (!tag) continue;
    if (!localByTag.has(tag)) localByTag.set(tag, img);
  }

  const latestReleaseTag = releasesForUi.length ? releasesForUi[0].tag : null;
  const imageStats = computeImageBytesStats(localImages);
  const tagsToProbe = new Set();
  for (const tag of CHANNEL_TAGS) tagsToProbe.add(tag);
  if (latestReleaseTag) tagsToProbe.add(latestReleaseTag);
  if (activeTag && (isChannelTag(activeTag) || isSemverReleaseTag(activeTag))) tagsToProbe.add(activeTag);
  for (const inst of retainedInstances) {
    if (inst.versionTag && (isChannelTag(inst.versionTag) || isSemverReleaseTag(inst.versionTag))) {
      tagsToProbe.add(inst.versionTag);
    }
  }
  for (const tag of localByTag.keys()) {
    if (isSemverReleaseTag(tag)) tagsToProbe.add(tag);
  }
  for (const t of CANONICAL_LOCAL_TAGS) {
    if (localByTag.has(t)) tagsToProbe.add(t);
  }

  const nowMs = Date.now();
  const cache = installabilityCache && typeof installabilityCache === 'object' ? installabilityCache : { entries: {} };
  const entries = cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  let cacheChanged = false;

  const shouldProbeRemote = !offline || forceRefresh;
  if (shouldProbeRemote) {
    for (const tag of tagsToProbe) {
      const existing = entries[tag];
      const existingStatus = existing?.status || 'unknown';
      const checkedAtMs = isoToMs(existing?.checkedAt);
      const recheckAfterMs = isoToMs(existing?.recheckAfter);

      let fresh = false;
      if (!forceRefresh) {
        const tagUpdatedAtMs = isoToMs(existing?.tagUpdatedAt);
        const tagMetadataCheckedAtMs = isoToMs(existing?.tagMetadataCheckedAt);
        const channelMetadataFresh = !isVisibleChannelTag(tag) ||
          Number.isFinite(tagUpdatedAtMs) ||
          (Number.isFinite(tagMetadataCheckedAtMs) && nowMs - tagMetadataCheckedAtMs < 24 * 60 * 60 * 1000);
        if (
          existingStatus === 'installable' &&
          Number.isFinite(checkedAtMs) &&
          nowMs - checkedAtMs < 24 * 60 * 60 * 1000 &&
          channelMetadataFresh
        ) {
          fresh = true;
        }
        if (existingStatus === 'not_yet_available' && Number.isFinite(recheckAfterMs) && nowMs < recheckAfterMs) {
          fresh = true;
        }
      }

      if (fresh) continue;

      try {
        const digestInfo = await docker.getRemoteDigest(imageRepo, tag);
        const exists = !!digestInfo?.exists;
        if (exists) {
          const tagMetadata = await bestEffortRemoteTagMetadata(docker, imageRepo, tag);
          const existingTagUpdatedAt = normalizeIsoString(existing?.tagUpdatedAt);
          entries[tag] = {
            status: 'installable',
            checkedAt: nowIso(),
            recheckAfter: null,
            digest: digestInfo?.digest || null,
            contentType: digestInfo?.contentType || null,
            tagUpdatedAt: tagMetadata?.tagUpdatedAt || existingTagUpdatedAt || null,
            tagMetadataCheckedAt: tagMetadata?.tagMetadataCheckedAt || null
          };
        } else {
          entries[tag] = {
            status: 'not_yet_available',
            checkedAt: nowIso(),
            recheckAfter: new Date(nowMs + 15 * 60 * 1000).toISOString(),
            digest: null,
            contentType: null
          };
        }
        cacheChanged = true;
      } catch {
        // Best-effort: leave cache entry unchanged on registry failures.
      }
    }
  }

  if (cacheChanged) {
    await stateStore.writeInstallabilityCache({ ...cache, entries, updatedAt: nowIso() });
  }

  const releaseEntries = [];

  const knownRemoteDigests = [];
  for (const t of Object.keys(entries)) {
    const e = entries[t];
    if (e && e.status === 'installable' && typeof e.digest === 'string' && e.digest) {
      knownRemoteDigests.push({ tag: t, digest: e.digest });
    }
  }

  const matchedReleaseTagByTag = new Map();
  for (const tag of CHANNEL_TAGS) {
    const matchedReleaseTag = matchedReleaseTagForLocalTag(tag, localByTag, knownRemoteDigests, latestReleaseTag);
    if (matchedReleaseTag) matchedReleaseTagByTag.set(tag, matchedReleaseTag);
  }
  containers = applyContainerMatchedReleaseTags(containers, matchedReleaseTagByTag);

  // First-class channel tags (not derived from GitHub Releases).
  for (const tag of CHANNEL_TAGS) {
    const img = localByTag.get(tag) || null;
    const cacheEntry = entries[tag] || null;
    const isActive = activeTag === tag;
    const localDigest = extractLocalDigest(img?.repoDigests);
    const publishedDigest = cacheEntry && typeof cacheEntry.digest === 'string' && cacheEntry.digest ? cacheEntry.digest : null;
    const differsFromPublished = !!(localDigest && publishedDigest && localDigest !== publishedDigest);
    let matchHint = differsFromPublished ? `Differs from published ${tag === 'testing' ? 'preview' : tag}` : null;
    const digestHint = differsFromPublished ? buildDigestHint(publishedDigest, localDigest) : null;
    const matchedReleaseTag = matchedReleaseTagByTag.get(tag) || '';

    if (!matchHint && localDigest && matchedReleaseTag) {
      matchHint = tag === 'latest'
        ? `Matches latest release ${releaseTagLabel(matchedReleaseTag)}`
        : `Matches published version ${releaseTagLabel(matchedReleaseTag)}`;
    }
    if (!matchHint && tag === 'latest' && latestReleaseTag) {
      matchHint = `Tracks latest release ${releaseTagLabel(latestReleaseTag)}`;
    }

    releaseEntries.push({
      id: tag,
      displayVersion: tag === 'testing' ? 'Testing' : tag,
      channelBadges: tag === 'testing' ? ['testing'] : undefined,
      category: 'official_release',
      availability: img ? 'installed' : 'available',
      installability: cacheEntry?.status === 'installable' ? 'installable' : cacheEntry?.status === 'not_yet_available' ? 'not_yet_available' : 'unknown',
      matchHint,
      matchedReleaseTag,
      digestHint,
      differsFromPublished,
      isActive,
      activeState: isActive ? activeState : null,
      publishedAt: null,
      updatedAt: normalizeIsoString(cacheEntry?.tagUpdatedAt),
      sizeBytes: img?.sizeBytes || null
    });
  }

  // Official semver releases (sorted descending by releases_client).
  for (const r of releasesForUi) {
    const tag = (r?.tag || '').trim();
    if (!isSemverReleaseTag(tag)) continue;

    const img = localByTag.get(tag) || null;
    const cacheEntry = entries[tag] || null;
    const isActive = activeTag === tag;
    const localDigest = extractLocalDigest(img?.repoDigests);
    const publishedDigest = cacheEntry && typeof cacheEntry.digest === 'string' && cacheEntry.digest ? cacheEntry.digest : null;
    const differsFromPublished = !!(localDigest && publishedDigest && localDigest !== publishedDigest);
    const matchHint = differsFromPublished ? 'Differs from published version' : null;
    const digestHint = differsFromPublished ? buildDigestHint(publishedDigest, localDigest) : null;

    const availabilityBase = img ? 'installed' : 'available';
    let availability = availabilityBase;
    if (isActive && latestReleaseTag && tag !== latestReleaseTag) {
      availability = 'update_available';
    }

    const badges = [];
    if (latestReleaseTag && tag === latestReleaseTag) badges.push('latest');

    releaseEntries.push({
      id: tag,
      displayVersion: tag.startsWith('v') ? tag.slice(1) : tag,
      channelBadges: badges.length ? badges : undefined,
      category: 'official_release',
      availability,
      installability: cacheEntry?.status === 'installable' ? 'installable' : cacheEntry?.status === 'not_yet_available' ? 'not_yet_available' : 'unknown',
      matchHint,
      digestHint,
      differsFromPublished,
      isActive,
      activeState: isActive ? activeState : null,
      publishedAt: r?.publishedAt || null,
      updatedAt: null,
      sizeBytes: img?.sizeBytes || null
    });
  }

  // Local builds (canonical + custom) derived from local images not represented above.
  const officialTagSet = new Set();
  for (const tag of CHANNEL_TAGS) officialTagSet.add(tag);
  for (const r of releasesForUi) {
    if (isSemverReleaseTag(r?.tag)) officialTagSet.add(r.tag);
  }

  const localBuildTags = [];
  for (const [tag] of localByTag.entries()) {
    if (officialTagSet.has(tag)) continue;
    localBuildTags.push(tag);
  }

  localBuildTags.sort((a, b) => {
    const ac = isCanonicalLocalTag(a) ? 0 : 1;
    const bc = isCanonicalLocalTag(b) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (ac === 0 && bc === 0) return CANONICAL_LOCAL_TAGS.indexOf(a) - CANONICAL_LOCAL_TAGS.indexOf(b);
    return a.localeCompare(b);
  });

  for (const tag of localBuildTags) {
    const img = localByTag.get(tag) || null;
    const isActive = activeTag === tag;

    const cacheEntry = entries[tag] || null;
    const localDigest = extractLocalDigest(img?.repoDigests);

    let installability = null;
    let matchHint = null;
    let differsFromPublished = null;
    let digestHint = null;

    if (isCanonicalLocalTag(tag)) {
      if (cacheEntry?.status === 'installable') {
        installability = 'installable';
        if (localDigest && typeof cacheEntry.digest === 'string' && cacheEntry.digest) {
          if (localDigest === cacheEntry.digest) {
            matchHint = 'Matches published version';
            differsFromPublished = false;
          } else {
            matchHint = 'Differs from published version';
            differsFromPublished = true;
            digestHint = buildDigestHint(cacheEntry.digest, localDigest);
          }
        }
      } else if (cacheEntry?.status === 'not_yet_available') {
        installability = 'not_yet_available';
      } else {
        installability = 'unknown';
      }
    }

    if (!matchHint && localDigest) {
      const match = knownRemoteDigests.find((d) => d.digest === localDigest);
      if (match && isSemverReleaseTag(match.tag)) {
        matchHint = `Matches published version ${match.tag.startsWith('v') ? match.tag.slice(1) : match.tag}`;
      } else if (match && match.tag === 'latest' && latestReleaseTag) {
        matchHint = `Matches latest release ${latestReleaseTag.startsWith('v') ? latestReleaseTag.slice(1) : latestReleaseTag}`;
      } else if (match && match.tag === 'testing') {
        matchHint = 'Matches published preview';
      }
    }

    releaseEntries.push({
      id: tag,
      displayVersion: tag,
      category: 'local_build',
      availability: 'installed',
      installability,
      matchHint,
      digestHint,
      differsFromPublished,
      isActive,
      activeState: isActive ? activeState : null,
      publishedAt: null,
      updatedAt: null,
      sizeBytes: img?.sizeBytes || null
    });
  }

  // Warm layer size manifests for visible tags in the background (best-effort).
  if (!offline && releasesForUi.length) {
    const warmTags = [...CHANNEL_TAGS, latestReleaseTag, ...releasesForUi.map((r) => r?.tag || '')].filter(Boolean);
    scheduleLayerSizesWarmup(docker, imageRepo, warmTags);
  }

  // If an operation is running, reflect it on the target row as "installing".
  if (_currentOperation && _currentOperation.status === 'running' && _currentOperation.targetTag) {
    const target = _currentOperation.targetTag;
    for (const v of releaseEntries) {
      if (v.id === target) {
        v.availability = 'installing';
      }
    }
  }

  const storage = {
    dockerRootDir: null,
    freeBytes: Number.isFinite(Number(freeBytes)) ? Math.floor(Number(freeBytes)) : null,
    usedBytes: imageStats.usedBytes,
    estimateAfterUpdateBytes: estimateAfterUpdateBytes(freeBytes, latestReleaseTag, localByTag, imageStats)
  };

  return {
    versions: releaseEntries,
    containers,
    retainedInstances,
    remoteInstances: remoteInstancesWithHealth,
    retentionPolicy,
    portPreferences,
    storagePreferences,
    instanceDefaults,
    uiUrl,
    lastSyncedAt,
    offline,
    storage,
    runtime,
    runtimeDiagnostics
  };
}

async function refreshDockerManager(options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const state = await buildDerivedState({ forceRefresh });
  _cachedState = stateWithBackgroundOperations(state);
  if (Array.isArray(_cachedState.remoteInstances)) {
    _cachedState = {
      ..._cachedState,
      remoteInstances: enrichRemoteInstancesWithHealth(_cachedState.remoteInstances)
    };
  }
  events.emit('state', _cachedState);
  return _cachedState;
}

async function getDockerManagerState() {
  if (_cachedState) return _cachedState;
  return await refreshDockerManager({ forceRefresh: false });
}

function assertKeepCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error('Invalid retention policy');
    err.code = 'INVALID_RETENTION_POLICY';
    throw err;
  }
  const keepCount = Math.max(0, Math.min(20, Math.floor(n)));
  return keepCount;
}

function assertContainerId(value) {
  const v = (value || '').trim();
  if (!v || v.length > 128) {
    const err = new Error('Invalid container id');
    err.code = 'INVALID_CONTAINER_ID';
    throw err;
  }
  if (!/^[a-f0-9]+$/i.test(v)) {
    const err = new Error('Invalid container id');
    err.code = 'INVALID_CONTAINER_ID';
    throw err;
  }
  return v;
}

function assertDataLossAck(value) {
  const v = (value || '').trim();
  if (v !== 'has_backup' && v !== 'proceed_without_backup') {
    const err = new Error('Invalid data loss acknowledgement');
    err.code = 'INVALID_DATA_LOSS_ACK';
    throw err;
  }
  return v;
}

function sanitizeInstanceName(value, fallback = 'agent-zero') {
  const v = (value || '').trim();
  const cleaned = v
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function parsePortMappings(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const source = raw || '0:80';
  const tokens = source
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!tokens.length) tokens.push('0:80');
  if (tokens.length > 12) {
    const err = new Error('Too many port mappings');
    err.code = 'INVALID_PORT_MAPPINGS';
    throw err;
  }

  const mappings = [];
  const seen = new Set();

  for (const token of tokens) {
    const parts = token.split(':');
    if (parts.length !== 2) {
      const err = new Error(`Invalid port mapping: ${token}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }

    const hostPort = Number(parts[0]);
    const containerPart = String(parts[1] || '').replace(/\/tcp$/i, '');
    const containerPort = Number(containerPart);

    if (!Number.isInteger(hostPort) || hostPort < 0 || hostPort > 65535) {
      const err = new Error(`Invalid host port in mapping: ${token}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }
    if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) {
      const err = new Error(`Invalid container port in mapping: ${token}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }

    const key = `${containerPort}/tcp`;
    if (seen.has(key)) {
      const err = new Error(`Duplicate container port mapping: ${containerPort}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }
    seen.add(key);
    mappings.push({ hostPort, containerPort, key });
  }

  return mappings;
}

function normalizePortBindingKey(key) {
  const match = String(key || '').trim().match(/^(\d+)\/(tcp|udp)$/i);
  if (!match) return null;
  const containerPort = Number(match[1]);
  if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) return null;
  return {
    key: `${containerPort}/${match[2].toLowerCase()}`,
    containerPort
  };
}

function normalizeHostPort(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function normalizeHostIp(value) {
  const text = String(value || '').trim();
  if (text === '::1' || text === '[::1]') return '::1';
  return '127.0.0.1';
}

function portMappingsFromNetworkSettings(inspect) {
  const ports = inspect?.NetworkSettings?.Ports;
  if (!ports || typeof ports !== 'object') return [];

  const mappings = [];
  for (const [rawKey, bindings] of Object.entries(ports)) {
    const parsed = normalizePortBindingKey(rawKey);
    if (!parsed) continue;
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      const hostPort = normalizeHostPort(binding?.HostPort, 0);
      if (hostPort <= 0) continue;
      mappings.push({
        hostPort,
        containerPort: parsed.containerPort,
        key: parsed.key,
        hostIp: normalizeHostIp(binding?.HostIp)
      });
    }
  }
  return mappings;
}

function portMappingsFromHostConfigPortBindings(portBindings) {
  const source = isPlainObject(portBindings) ? portBindings : {};
  const mappings = [];

  for (const [rawKey, bindings] of Object.entries(source)) {
    const parsed = normalizePortBindingKey(rawKey);
    if (!parsed) continue;
    const list = Array.isArray(bindings) && bindings.length ? bindings : [{ HostIp: '127.0.0.1', HostPort: '0' }];
    for (const binding of list) {
      mappings.push({
        hostPort: normalizeHostPort(binding?.HostPort, 0),
        containerPort: parsed.containerPort,
        key: parsed.key,
        hostIp: normalizeHostIp(binding?.HostIp)
      });
    }
  }

  return mappings;
}

function replacementPortMappingsFromInspect(inspect) {
  const settled = portMappingsFromNetworkSettings(inspect);
  if (settled.length) return settled;
  return portMappingsFromHostConfigPortBindings(inspect?.HostConfig?.PortBindings);
}

function firstHostPortForBinding(portBindings, key) {
  const bindings = isPlainObject(portBindings) ? portBindings[key] : null;
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const hostPort = normalizeHostPort(binding?.HostPort, 0);
    if (hostPort > 0) return hostPort;
  }
  return 0;
}

async function allocateOpenHostPort(reservedHostPorts = new Set()) {
  const reserved = reservedHostPorts instanceof Set ? reservedHostPorts : new Set();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      const done = (fn, value) => {
        server.removeAllListeners();
        fn(value);
      };
      server.once('error', (error) => done(reject, error));
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address();
        const selected = Number(address && typeof address === 'object' ? address.port : 0);
        server.close((error) => {
          if (error) done(reject, error);
          else done(resolve, selected);
        });
      });
      if (typeof server.unref === 'function') server.unref();
    });
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !reserved.has(port)) return port;
  }

  const err = new Error('Unable to find an open host port');
  err.code = 'NO_OPEN_PORT';
  throw err;
}

async function settlePortMappings(mappings, options = {}) {
  const source = Array.isArray(mappings) ? mappings : [];
  const allocate = typeof options?.allocateHostPort === 'function' ? options.allocateHostPort : allocateOpenHostPort;
  const reserved = new Set(Array.isArray(options?.reservedHostPorts) ? options.reservedHostPorts : []);

  for (const mapping of source) {
    const hostPort = normalizeHostPort(mapping?.hostPort, 0);
    if (hostPort > 0) reserved.add(hostPort);
  }

  const settled = [];
  for (const mapping of source) {
    const containerPort = Number(mapping?.containerPort);
    if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) continue;
    const keyInfo = normalizePortBindingKey(mapping?.key || `${containerPort}/tcp`);
    if (!keyInfo) continue;
    let hostPort = normalizeHostPort(mapping?.hostPort, 0);
    if (hostPort <= 0) {
      // eslint-disable-next-line no-await-in-loop
      hostPort = await allocate(reserved);
      reserved.add(hostPort);
    }
    settled.push({
      ...mapping,
      hostPort,
      containerPort,
      key: keyInfo.key,
      hostIp: normalizeHostIp(mapping?.hostIp)
    });
  }

  return settled;
}

async function settlePortBindings(portBindings, options = {}) {
  const source = isPlainObject(portBindings) ? portBindings : {};
  const allocate = typeof options?.allocateHostPort === 'function' ? options.allocateHostPort : allocateOpenHostPort;
  const reserved = new Set(Array.isArray(options?.reservedHostPorts) ? options.reservedHostPorts : []);

  for (const bindings of Object.values(source)) {
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      const hostPort = normalizeHostPort(binding?.HostPort, 0);
      if (hostPort > 0) reserved.add(hostPort);
    }
  }

  const out = {};
  for (const [rawKey, bindings] of Object.entries(source)) {
    const parsed = normalizePortBindingKey(rawKey);
    if (!parsed) continue;
    const list = Array.isArray(bindings) && bindings.length ? bindings : [{ HostIp: '127.0.0.1', HostPort: '0' }];
    out[parsed.key] = [];
    for (const binding of list) {
      let hostPort = normalizeHostPort(binding?.HostPort, 0);
      if (hostPort <= 0) {
        // eslint-disable-next-line no-await-in-loop
        hostPort = await allocate(reserved);
        reserved.add(hostPort);
      }
      out[parsed.key].push({
        HostIp: normalizeHostIp(binding?.HostIp),
        HostPort: String(hostPort)
      });
    }
  }
  return out;
}

function portBindingsFromMappings(mappings) {
  const portBindings = {};
  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    const containerPort = Number(mapping?.containerPort);
    if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) continue;
    const parsed = normalizePortBindingKey(mapping?.key || `${containerPort}/tcp`);
    if (!parsed) continue;
    if (!Array.isArray(portBindings[parsed.key])) portBindings[parsed.key] = [];
    portBindings[parsed.key].push({
      HostIp: normalizeHostIp(mapping?.hostIp),
      HostPort: String(normalizeHostPort(mapping?.hostPort, 0))
    });
  }
  return portBindings;
}

function parseEnvText(value) {
  const raw = typeof value === 'string' ? value : '';
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 80) {
    const err = new Error('Too many environment variables');
    err.code = 'INVALID_ENV_VARS';
    throw err;
  }

  const env = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) {
      const err = new Error(`Invalid environment variable: ${line}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      const err = new Error(`Invalid environment variable name: ${key}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    if (seen.has(key)) {
      const err = new Error(`Duplicate environment variable: ${key}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    if (line.length > 4096) {
      const err = new Error(`Environment variable is too long: ${key}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    seen.add(key);
    env.push(`${key}=${val}`);
  }
  return env;
}

function parseMountsText(value) {
  const raw = typeof value === 'string' ? value : '';
  const entries = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (entries.length > 32) {
    const err = new Error('Too many mounts');
    err.code = 'INVALID_MOUNTS';
    throw err;
  }

  const binds = [];
  for (const entry of entries) {
    if (entry.startsWith('#')) continue;
    if (/[\x00-\x1F\x7F]/.test(entry)) {
      const err = new Error('Invalid mount');
      err.code = 'INVALID_MOUNTS';
      throw err;
    }

    const parts = entry.split(':');
    if (parts.length < 2 || parts.length > 3) {
      const err = new Error(`Invalid mount: ${entry}`);
      err.code = 'INVALID_MOUNTS';
      throw err;
    }

    const source = parts[0].trim();
    const target = parts[1].trim();
    const mode = (parts[2] || 'rw').trim();
    const namedVolume = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(source);
    const hostPath = source.startsWith('/') && !source.includes('..');
    if (!source || (!namedVolume && !hostPath)) {
      const err = new Error(`Invalid mount source: ${source || entry}`);
      err.code = 'INVALID_MOUNTS';
      throw err;
    }
    if (!target.startsWith('/') || target.includes('..')) {
      const err = new Error(`Invalid mount target: ${target || entry}`);
      err.code = 'INVALID_MOUNTS';
      throw err;
    }
    if (mode !== 'ro' && mode !== 'rw') {
      const err = new Error(`Invalid mount mode: ${mode || entry}`);
      err.code = 'INVALID_MOUNTS';
      throw err;
    }

    binds.push(`${source}:${target}:${mode}`);
  }

  return binds;
}

function normalizeCredentialInputText(value, maxLength, options = {}) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ');
  const trimmed = options?.trim === false ? cleaned : cleaned.trim();
  const normalized = options?.collapseWhitespace === false
    ? trimmed
    : trimmed.replace(/\s+/g, ' ');
  return normalized.slice(0, maxLength);
}

function normalizeActivationCredentials(raw) {
  const credentials = isPlainObject(raw?.credentials) ? raw.credentials : raw;
  const remember =
    credentials?.remember === true ||
    credentials?.rememberCredentials === true ||
    raw?.rememberCredentials === true;
  const username = normalizeCredentialInputText(credentials?.username ?? raw?.credentialUsername, 256);
  const password = normalizeCredentialInputText(credentials?.password ?? raw?.credentialPassword, 4096, { collapseWhitespace: false, trim: false });
  return { remember, username, password };
}

function normalizeActivationOptions(options = {}, tag = '') {
  const raw = options && typeof options === 'object' ? options : {};
  const fallbackName = sanitizeInstanceName(`agent-zero-${tag || 'instance'}`);
  const hasPortMappings = typeof raw.portMappings === 'string' && raw.portMappings.trim();
  return {
    instanceName: sanitizeInstanceName(raw.instanceName, fallbackName),
    portMappings: hasPortMappings ? parsePortMappings(raw.portMappings) : null,
    env: parseEnvText(raw.envText),
    storage: normalizeStorageOverride(raw),
    credentials: normalizeActivationCredentials(raw)
  };
}

function normalizeCustomImageOptions(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  const spec = assertCustomImageSpec(raw);
  const imageTail = spec.imageRepo.split('/').filter(Boolean).pop() || 'image';
  const fallbackName = sanitizeInstanceName(`${imageTail}-${spec.tag}`, 'agent-zero-dev');
  const hasPortMappings = typeof raw.portMappings === 'string' && raw.portMappings.trim();
  return {
    ...spec,
    instanceName: sanitizeInstanceName(raw.instanceName, fallbackName),
    portMappings: hasPortMappings ? parsePortMappings(raw.portMappings) : parsePortMappings('0:80'),
    env: parseEnvText(raw.envText),
    binds: parseMountsText(raw.mountsText),
    storage: normalizeStorageOverride(raw),
    pull: raw.pull !== false
  };
}

function clampContainerLogLines(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CONTAINER_LOG_DEFAULT_LINES;
  return Math.max(1, Math.min(CONTAINER_LOG_MAX_LINES, Math.floor(n)));
}

function normalizeLogLineText(value) {
  const raw = String(value ?? '');
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (cleaned.length <= CONTAINER_LOG_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, CONTAINER_LOG_MAX_CHARS)}...`;
}

function sanitizeContainerLogEvent(evt) {
  const stream = evt?.stream === 'stderr' ? 'stderr' : 'stdout';
  const out = {
    stream,
    line: normalizeLogLineText(evt?.line)
  };
  if (evt?.partial === true) out.partial = true;
  return out;
}

function containerNameFromInspect(inspect) {
  const raw = typeof inspect?.Name === 'string' ? inspect.Name.replace(/^\//, '') : '';
  return raw || '';
}

function sourceInstanceNameFromInspect(inspect, fallback = 'instance') {
  const labels = isPlainObject(inspect?.Config?.Labels) ? inspect.Config.Labels : {};
  const fromLabel = typeof labels['a0.launcher.instanceName'] === 'string' ? labels['a0.launcher.instanceName'] : '';
  const fromName = containerNameFromInspect(inspect);
  const fromHost = typeof inspect?.Config?.Hostname === 'string' ? inspect.Config.Hostname : '';
  const raw = (fromLabel || fromName || fromHost || fallback).trim();
  return raw.replace(/\s+/g, ' ').slice(0, 80) || fallback;
}

function cloneFriendlyInstanceName(sourceName) {
  const base = String(sourceName || '').trim().replace(/\s+/g, ' ');
  const label = base ? `${base} clone` : 'Cloned instance';
  return label.slice(0, 80);
}

function cloneOperationHeadline(sourceName) {
  const name = String(sourceName || '').trim().replace(/\s+/g, ' ');
  return `Cloning ${name || 'instance'}`;
}

function cloneContainerName(sourceName) {
  const suffix = Date.now().toString(36);
  const base = sanitizeInstanceName(`${sourceName || 'instance'}-clone`, 'agent-zero-clone').slice(0, 48);
  return sanitizeInstanceName(`${base}-${suffix}`, `agent-zero-clone-${suffix}`);
}

function migratedInstanceContainerName(sourceName) {
  const suffix = Date.now().toString(36);
  const base = sanitizeInstanceName(`a0-inst-${sourceName || 'instance'}`, 'a0-inst').slice(0, 48);
  return sanitizeInstanceName(`${base}-${suffix}`, `a0-inst-${suffix}`);
}

function cloneImageRefForContainer(containerId) {
  const suffix = Date.now().toString(36);
  const shortId = String(containerId || '').slice(0, 12).toLowerCase() || 'container';
  return `${CLONE_IMAGE_REPO}:clone-${suffix}-${shortId}`;
}

function normalizeDockerLabels(labels) {
  const out = {};
  for (const [key, value] of Object.entries(isPlainObject(labels) ? labels : {})) {
    if (typeof key !== 'string' || !key) continue;
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function clonePortBindings(portBindings) {
  const out = {};
  const source = isPlainObject(portBindings) ? portBindings : {};
  for (const [key, bindings] of Object.entries(source)) {
    if (!/^\d+\/(?:tcp|udp)$/i.test(key)) continue;
    const list = Array.isArray(bindings) && bindings.length ? bindings : [{ HostIp: '127.0.0.1' }];
    out[key] = list.map((binding) => ({
      HostIp: typeof binding?.HostIp === 'string' && binding.HostIp ? binding.HostIp : '127.0.0.1',
      HostPort: '0'
    }));
  }
  return out;
}

function cloneExposedPorts(configExposedPorts, portBindings) {
  const out = {};
  const exposed = isPlainObject(configExposedPorts) ? configExposedPorts : {};
  for (const key of Object.keys(exposed)) {
    if (/^\d+\/(?:tcp|udp)$/i.test(key)) out[key] = {};
  }
  for (const key of Object.keys(isPlainObject(portBindings) ? portBindings : {})) {
    if (/^\d+\/(?:tcp|udp)$/i.test(key)) out[key] = {};
  }
  return out;
}

function portMapLabelFromBindings(portBindings) {
  const parts = [];
  const source = isPlainObject(portBindings) ? portBindings : {};
  for (const [key, bindings] of Object.entries(source)) {
    const containerPort = String(key || '').split('/')[0];
    if (!containerPort) continue;
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      parts.push(`${normalizeHostPort(binding?.HostPort, 0)}:${containerPort}`);
    }
  }
  return parts.join(',');
}

async function copyContainerPathIfPresent(docker, sourceContainerId, sourcePath, targetContainerId, targetParentPath) {
  const copied = await docker.copyContainerPathToContainer(
    sourceContainerId,
    sourcePath,
    targetContainerId,
    targetParentPath
  );
  return copied?.copied !== false;
}

async function writeFilteredCloneTextFile(docker, sourceContainerId, sourcePath, targetContainerId, targetPath, filter) {
  if (typeof docker.readContainerTextFile !== 'function' || typeof docker.writeContainerTextFile !== 'function') return false;
  const sourceText = await docker.readContainerTextFile(sourceContainerId, sourcePath, { maxBytes: 1024 * 1024 });
  if (sourceText === null || sourceText === undefined) return false;
  const filtered = filter(sourceText);
  if (!filtered) return false;
  const result = await docker.writeContainerTextFile(targetContainerId, targetPath, filtered);
  return result?.written !== false;
}

async function ensureCloneTargetDirectory(docker, containerId, directoryPath) {
  if (typeof docker.ensureContainerDirectory !== 'function') return;
  await docker.ensureContainerDirectory(containerId, directoryPath);
}

async function copyClonePluginEntries(docker, sourceContainerId, targetContainerId, selection) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  const needsPluginRoot = normalized.providers || normalized.secrets || normalized.plugins;
  if (!needsPluginRoot) return 0;
  await ensureCloneTargetDirectory(docker, targetContainerId, `${WORKSPACE_MOUNT_TARGET}/plugins`);

  let copiedCount = 0;
  if (normalized.providers) {
    if (await copyContainerPathIfPresent(
      docker,
      sourceContainerId,
      `${WORKSPACE_MOUNT_TARGET}/plugins/_model_config`,
      targetContainerId,
      `${WORKSPACE_MOUNT_TARGET}/plugins`
    )) copiedCount += 1;
  }
  if (normalized.secrets) {
    if (await copyContainerPathIfPresent(
      docker,
      sourceContainerId,
      `${WORKSPACE_MOUNT_TARGET}/plugins/_oauth`,
      targetContainerId,
      `${WORKSPACE_MOUNT_TARGET}/plugins`
    )) copiedCount += 1;
  }

  if (!normalized.plugins) return copiedCount;
  if (typeof docker.listContainerDirectory !== 'function') {
    const err = new Error('Selective plugin cloning requires directory inspection support.');
    err.code = 'CLONE_PLUGIN_LIST_UNAVAILABLE';
    throw err;
  }

  const entries = await docker.listContainerDirectory(sourceContainerId, `${WORKSPACE_MOUNT_TARGET}/plugins`);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name || '').trim();
    if (!name || name.includes('/') || name === '.' || name === '..') continue;
    if (CLONE_RESERVED_PLUGIN_ENTRIES.includes(name)) continue;
    if (await copyContainerPathIfPresent(
      docker,
      sourceContainerId,
      `${WORKSPACE_MOUNT_TARGET}/plugins/${name}`,
      targetContainerId,
      `${WORKSPACE_MOUNT_TARGET}/plugins`
    )) copiedCount += 1;
  }
  return copiedCount;
}

async function copySelectedWorkspaceData(docker, sourceContainerId, targetContainerId, selection, onProgress = null) {
  const normalized = normalizeCloneWorkspaceSelection(selection);
  if (cloneWorkspaceSelectionIsEmpty(normalized)) return { copied: false, selectedCategories: [] };
  if (typeof docker.copyContainerPathToContainer !== 'function') {
    const err = new Error('Workspace copy is not supported by the selected Docker runtime.');
    err.code = 'WORKSPACE_COPY_UNAVAILABLE';
    throw err;
  }

  const selectedCategories = selectedCloneWorkspaceCategoryIds(normalized);
  if (cloneWorkspaceSelectionIsAll(normalized)) {
    onProgress?.('Copying all /a0/usr data');
    const copied = await copyContainerPathIfPresent(
      docker,
      sourceContainerId,
      WORKSPACE_MOUNT_TARGET,
      targetContainerId,
      '/a0'
    );
    return { copied, selectedCategories, fullWorkspace: true };
  }

  let copiedCount = 0;

  onProgress?.('Copying credentials and settings');
  if (normalized.auth || normalized.secrets || normalized.settings) {
    if (await writeFilteredCloneTextFile(
      docker,
      sourceContainerId,
      `${WORKSPACE_MOUNT_TARGET}/.env`,
      targetContainerId,
      `${WORKSPACE_MOUNT_TARGET}/.env`,
      (text) => filterEnvTextForClone(text, normalized)
    )) copiedCount += 1;
  }
  if (normalized.auth || normalized.secrets || normalized.settings || normalized.mcp || normalized.providers) {
    if (await writeFilteredCloneTextFile(
      docker,
      sourceContainerId,
      `${WORKSPACE_MOUNT_TARGET}/settings.json`,
      targetContainerId,
      `${WORKSPACE_MOUNT_TARGET}/settings.json`,
      (text) => filterSettingsJsonForClone(text, normalized)
    )) copiedCount += 1;
  }
  if (normalized.secrets) {
    if (await copyContainerPathIfPresent(
      docker,
      sourceContainerId,
      `${WORKSPACE_MOUNT_TARGET}/secrets.env`,
      targetContainerId,
      WORKSPACE_MOUNT_TARGET
    )) copiedCount += 1;
  }

  onProgress?.('Copying plugin data');
  copiedCount += await copyClonePluginEntries(docker, sourceContainerId, targetContainerId, normalized);

  const pathGroups = [
    ['agents', ['agents']],
    ['chats', ['chats']],
    ['skills', ['skills']],
    ['projects', ['projects']],
    ['memory', ['memory', 'knowledge', 'scheduler', '.time_travel']],
    ['files', ['workdir', 'uploads', 'downloads', 'api']]
  ];
  for (const [category, names] of pathGroups) {
    if (!normalized[category]) continue;
    onProgress?.(`Copying ${category} data`);
    for (const name of names) {
      if (await copyContainerPathIfPresent(
        docker,
        sourceContainerId,
        `${WORKSPACE_MOUNT_TARGET}/${name}`,
        targetContainerId,
        WORKSPACE_MOUNT_TARGET
      )) copiedCount += 1;
    }
  }

  return {
    copied: copiedCount > 0,
    copiedCount,
    selectedCategories,
    fullWorkspace: false
  };
}

function makeDockerManagerError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertHostZipPath(value, mode = 'read') {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 4096 || /[\0\r\n]/.test(raw)) {
    throw makeDockerManagerError('INVALID_BACKUP_PATH', 'Invalid backup path');
  }
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(resolved) || !resolved.toLowerCase().endsWith('.zip')) {
    throw makeDockerManagerError('INVALID_BACKUP_PATH', 'Backup path must be a .zip file');
  }
  if (mode === 'read' && !fsSync.existsSync(resolved)) {
    throw makeDockerManagerError('BACKUP_NOT_FOUND', 'Backup file was not found');
  }
  return resolved;
}

function safeRelativeArchivePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/u, '');
  if (!raw || /[\0\r\n]/.test(raw)) return '';
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  return normalized;
}

function workspaceRelativeFromTarEntry(entryName) {
  const name = safeRelativeArchivePath(entryName);
  if (!name) return '';
  if (name === 'usr') return '';
  if (name.startsWith('usr/')) return name.slice('usr/'.length);
  if (name === 'a0/usr') return '';
  if (name.startsWith('a0/usr/')) return name.slice('a0/usr/'.length);
  return '';
}

function restorePrefixesFromBackupMetadata(metadata = {}) {
  const roots = new Set(['a0']);
  const environmentInfo = isPlainObject(metadata?.environment_info) ? metadata.environment_info : {};
  const backedUpRoot = typeof environmentInfo.agent_zero_root === 'string' ? environmentInfo.agent_zero_root : '';
  const safeRoot = safeRelativeArchivePath(backedUpRoot);
  if (safeRoot) roots.add(safeRoot);
  return [...roots].map((root) => `${root.replace(/\/+$/u, '')}/usr/`);
}

function workspaceTarEntryFromBackupEntry(entryName, metadata = {}) {
  const name = safeRelativeArchivePath(entryName);
  if (!name || name === 'metadata.json' || name === 'checksums.json') return '';
  if (name === 'usr') return '';
  if (name.startsWith('usr/')) return name;
  for (const prefix of restorePrefixesFromBackupMetadata(metadata)) {
    if (name === prefix.slice(0, -1)) return '';
    if (name.startsWith(prefix)) {
      const rel = safeRelativeArchivePath(name.slice(prefix.length));
      return rel ? `usr/${rel}` : '';
    }
  }
  return '';
}

function countDirectoriesFromBackupFiles(files) {
  const dirs = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = String(file?.path || '').trim();
    const dir = path.posix.dirname(filePath);
    if (!dir || dir === '.') continue;
    const parts = dir.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      dirs.add(`/${parts.slice(0, i).join('/')}`);
    }
  }
  return dirs.size;
}

function backupNameFromPath(filePath) {
  const base = path.basename(String(filePath || 'agent-zero-backup.zip')).replace(/\.zip$/i, '');
  return base.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120) || 'agent-zero-backup';
}

function buildAgentZeroBackupMetadata({ filePath, files, sourceName }) {
  const safeFiles = Array.isArray(files) ? files : [];
  const backupName = backupNameFromPath(filePath);
  const backupSize = safeFiles.reduce((sum, file) => sum + (Number.isFinite(Number(file?.size)) ? Number(file.size) : 0), 0);
  return {
    agent_zero_version: 'unknown',
    timestamp: nowIso(),
    backup_name: backupName,
    include_hidden: true,
    include_patterns: [`${WORKSPACE_MOUNT_TARGET}/**`],
    exclude_patterns: [],
    system_info: {
      source: 'Agent Zero Launcher',
      source_instance: String(sourceName || '').slice(0, 160)
    },
    environment_info: {
      agent_zero_root: AGENT_ZERO_CONTAINER_ROOT,
      working_directory: AGENT_ZERO_CONTAINER_ROOT,
      runtime_mode: 'container',
      source: 'a0-launcher'
    },
    backup_author: 'Agent Zero Launcher',
    backup_config: {
      include_patterns: [`${WORKSPACE_MOUNT_TARGET}/**`],
      exclude_patterns: [],
      include_hidden: true,
      compression_level: 6,
      integrity_check: false
    },
    files: safeFiles,
    total_files: safeFiles.length,
    backup_size: backupSize,
    directory_count: countDirectoriesFromBackupFiles(safeFiles)
  };
}

let crc32Table = null;

function crc32(buffer) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crc32Table[i] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDosDateTime(value) {
  const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date(value || Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = Math.max(1, Math.min(12, date.getMonth() + 1));
  const day = Math.max(1, Math.min(31, date.getDate()));
  const hours = Math.max(0, Math.min(23, date.getHours()));
  const minutes = Math.max(0, Math.min(59, date.getMinutes()));
  const seconds = Math.max(0, Math.min(29, Math.floor(date.getSeconds() / 2)));
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds
  };
}

function assertZip32Value(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > ZIP_UINT32_MAX) {
    throw makeDockerManagerError('BACKUP_TOO_LARGE', `Backup ${field} is too large for ZIP export`);
  }
  return Math.floor(n);
}

class ZipFileWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = fsSync.createWriteStream(filePath);
    this.offset = 0;
    this.entries = [];
    this.closed = false;
  }

  async write(buffer) {
    const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!chunk.length) return;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.stream.off('error', onError);
        reject(error);
      };
      this.stream.once('error', onError);
      this.stream.write(chunk, (error) => {
        this.stream.off('error', onError);
        if (error) reject(error);
        else resolve();
      });
    });
    this.offset += chunk.length;
  }

  async addFile(entryName, data, mtime = new Date()) {
    if (this.closed) throw makeDockerManagerError('BACKUP_WRITE_FAILED', 'Backup writer is closed');
    const name = safeRelativeArchivePath(entryName);
    if (!name) throw makeDockerManagerError('INVALID_BACKUP_ENTRY', 'Invalid backup entry name');
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > ZIP_UINT16_MAX) throw makeDockerManagerError('INVALID_BACKUP_ENTRY', 'Backup entry name is too long');

    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    const method = 8;
    const crc = crc32(raw);
    const { date, time } = zipDosDateTime(mtime);
    const localOffset = assertZip32Value(this.offset, 'offset');
    const compressedSize = assertZip32Value(compressed.length, 'entry');
    const uncompressedSize = assertZip32Value(raw.length, 'entry');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    await this.write(localHeader);
    await this.write(nameBytes);
    await this.write(compressed);

    this.entries.push({
      nameBytes,
      method,
      time,
      date,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const centralOffset = assertZip32Value(this.offset, 'central directory offset');
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.uncompressedSize, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      await this.write(header);
      await this.write(entry.nameBytes);
    }

    const centralSize = assertZip32Value(this.offset - centralOffset, 'central directory');
    if (this.entries.length > ZIP_UINT16_MAX) {
      throw makeDockerManagerError('BACKUP_TOO_LARGE', 'Backup has too many files for ZIP export');
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);

    await new Promise((resolve, reject) => {
      this.stream.end(resolve);
      this.stream.once('error', reject);
    });
  }

  destroy() {
    try {
      this.stream.destroy();
    } catch {
      // ignore cleanup failure
    }
  }
}

function readStreamBuffer(stream, maxBytes = ZIP_UINT32_MAX) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        const error = makeDockerManagerError('BACKUP_TOO_LARGE', 'Backup entry is too large');
        try {
          stream.destroy(error);
        } catch {
          // ignore
        }
        fail(error);
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}

function drainStream(stream) {
  return new Promise((resolve, reject) => {
    stream.resume();
    stream.once('error', reject);
    stream.once('end', resolve);
  });
}

async function createAgentZeroBackupZip(docker, containerId, outputPath, options = {}) {
  if (!docker || typeof docker.getContainerPathArchive !== 'function') {
    throw makeDockerManagerError('BACKUP_UNAVAILABLE', 'Container backup is not supported by this runtime.');
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const source = await docker.getContainerPathArchive(containerId, WORKSPACE_MOUNT_TARGET);
  const extract = tarStream.extract();
  const writer = new ZipFileWriter(outputPath);
  const files = [];
  let pendingError = null;

  const done = new Promise((resolve, reject) => {
    extract.on('entry', async (header, stream, next) => {
      try {
        const rel = workspaceRelativeFromTarEntry(header?.name);
        if (!rel) {
          await drainStream(stream);
          next();
          return;
        }

        if (header?.type !== 'file') {
          await drainStream(stream);
          next();
          return;
        }

        const data = await readStreamBuffer(stream);
        const zipPath = `a0/usr/${rel}`;
        const mtime = header?.mtime instanceof Date ? header.mtime : new Date();
        await writer.addFile(zipPath, data, mtime);
        files.push({
          path: `/${zipPath}`,
          size: data.length,
          modified: mtime.toISOString(),
          type: 'file'
        });
        next();
      } catch (error) {
        pendingError = error;
        try {
          stream.destroy(error);
        } catch {
          // ignore
        }
        next(error);
      }
    });
    extract.once('finish', resolve);
    extract.once('error', reject);
  });

  try {
    source.once('error', (error) => extract.destroy(error));
    source.pipe(extract);
    await done;
    if (pendingError) throw pendingError;
    if (!files.length) throw makeDockerManagerError('BACKUP_EMPTY', 'No /a0/usr files were found to back up.');

    const metadata = buildAgentZeroBackupMetadata({
      filePath: outputPath,
      files,
      sourceName: options.sourceName
    });
    await writer.addFile('metadata.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'), new Date());
    await writer.close();
    return {
      filePath: outputPath,
      fileCount: files.length,
      sizeBytes: metadata.backup_size,
      backupName: metadata.backup_name
    };
  } catch (error) {
    writer.destroy();
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error) reject(error);
      else resolve(zipfile);
    });
  });
}

function readZipEntryBuffer(zipfile, entry, maxBytes = ZIP_UINT32_MAX) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      readStreamBuffer(stream, maxBytes).then(resolve, reject);
    });
  });
}

async function forEachZipEntry(filePath, onEntry) {
  const zipfile = await openZipFile(filePath);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        // ignore
      }
      reject(error);
    };
    zipfile.on('entry', (entry) => {
      Promise.resolve(onEntry(zipfile, entry))
        .then(() => {
          if (!settled) zipfile.readEntry();
        })
        .catch(fail);
    });
    zipfile.once('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.once('error', fail);
    zipfile.readEntry();
  });
}

async function readBackupMetadataFromZip(filePath) {
  let metadata = {};
  await forEachZipEntry(filePath, async (zipfile, entry) => {
    if (String(entry?.fileName || '') !== 'metadata.json') return;
    const data = await readZipEntryBuffer(zipfile, entry, 10 * 1024 * 1024);
    try {
      const parsed = JSON.parse(data.toString('utf8'));
      if (isPlainObject(parsed)) metadata = parsed;
    } catch {
      throw makeDockerManagerError('INVALID_BACKUP_ARCHIVE', 'Backup metadata is not valid JSON.');
    }
  });
  return metadata;
}

function addTarPackEntry(pack, header, data) {
  return new Promise((resolve, reject) => {
    pack.entry(header, data, (error) => (error ? reject(error) : resolve()));
  });
}

async function restoreAgentZeroBackupZip(docker, containerId, inputPath, onProgress = null) {
  if (!docker || typeof docker.putContainerPathArchive !== 'function') {
    throw makeDockerManagerError('RESTORE_UNAVAILABLE', 'Container restore is not supported by this runtime.');
  }

  const metadata = await readBackupMetadataFromZip(inputPath);
  const pack = tarStream.pack();
  const importPromise = docker.putContainerPathArchive(containerId, AGENT_ZERO_CONTAINER_ROOT, pack);
  let restoredFiles = 0;
  let restoredBytes = 0;

  try {
    await forEachZipEntry(inputPath, async (zipfile, entry) => {
      const entryName = String(entry?.fileName || '');
      if (!entryName || entryName.endsWith('/')) return;
      const tarName = workspaceTarEntryFromBackupEntry(entryName, metadata);
      if (!tarName) return;

      const data = await readZipEntryBuffer(zipfile, entry);
      await addTarPackEntry(pack, {
        name: tarName,
        size: data.length,
        mode: 0o644,
        mtime: typeof entry.getLastModDate === 'function' ? entry.getLastModDate() : new Date()
      }, data);
      restoredFiles += 1;
      restoredBytes += data.length;
      if (restoredFiles % 25 === 0) onProgress?.(`Restoring /a0/usr files (${restoredFiles})`);
    });

    if (!restoredFiles) {
      throw makeDockerManagerError('INVALID_BACKUP_ARCHIVE', 'No /a0/usr files were found in this backup.');
    }

    pack.finalize();
    await importPromise;
    return { restoredFiles, restoredBytes };
  } catch (error) {
    try {
      pack.destroy(error);
    } catch {
      // ignore
    }
    await importPromise.catch(() => {});
    throw error;
  }
}

function setIfPresent(target, key, value) {
  if (value === null || value === undefined || value === '') return;
  if (Array.isArray(value) && !value.length) return;
  if (isPlainObject(value) && !Object.keys(value).length) return;
  target[key] = value;
}

async function buildCloneCreateOptions(inspect, containerId, cloneImageRef, storagePreferences = null, options = {}) {
  const config = isPlainObject(inspect?.Config) ? inspect.Config : {};
  const host = isPlainObject(inspect?.HostConfig) ? inspect.HostConfig : {};
  const sourceLabels = normalizeDockerLabels(config.Labels);
  const sourceName = sourceInstanceNameFromInspect(inspect, String(containerId || '').slice(0, 12) || 'instance');
  const sourceImage = typeof config.Image === 'string' ? config.Image : '';
  const versionTag = sourceLabels['a0.launcher.versionTag'] || splitImageAndTag(sourceImage, '').tag || '';
  const workspaceSelection = normalizeCloneWorkspaceSelection(options?.workspaceCategories);

  const requestedPortBindings = options?.preserveSettledPorts === true
    ? (() => {
        const { portBindings } = buildPortExposure(replacementPortMappingsFromInspect(inspect));
        return portBindings;
      })()
    : clonePortBindings(host.PortBindings);
  const portBindings = await settlePortBindings(requestedPortBindings, options);
  const exposedPorts = cloneExposedPorts(config.ExposedPorts, portBindings);
  const portMapLabel = portMapLabelFromBindings(portBindings);

  const labels = {
    ...sourceLabels,
    'a0.launcher.managed': 'true',
    'a0.launcher.role': 'clone',
    'a0.launcher.instanceName': cloneFriendlyInstanceName(sourceName),
    'a0.launcher.cloneSourceContainerId': String(containerId || ''),
    'a0.launcher.cloneSourceName': containerNameFromInspect(inspect) || sourceName,
    'a0.launcher.cloneCreatedAt': nowIso(),
    'a0.launcher.cloneImageRef': cloneImageRef,
    'a0.launcher.cloneWorkspaceCategories': cloneWorkspaceSelectionLabel(workspaceSelection),
    'a0.launcher.cloneWorkspaceFull': cloneWorkspaceSelectionIsAll(workspaceSelection) ? 'true' : 'false'
  };
  if (versionTag) labels['a0.launcher.versionTag'] = versionTag;
  if (sourceImage) labels['a0.launcher.imageRef'] = sourceImage;
  if (portMapLabel) labels['a0.launcher.port.map'] = portMapLabel;
  labels['a0.launcher.port.ui'] = Object.prototype.hasOwnProperty.call(portBindings, '80/tcp')
    ? String(firstHostPortForBinding(portBindings, '80/tcp') || '')
    : '';
  labels['a0.launcher.port.ssh'] = Object.prototype.hasOwnProperty.call(portBindings, '22/tcp')
    ? String(firstHostPortForBinding(portBindings, '22/tcp') || '')
    : '';

  const hostConfig = {};
  if (Object.keys(portBindings).length) hostConfig.PortBindings = portBindings;
  if (Array.isArray(host.Binds) && host.Binds.length) hostConfig.Binds = [...host.Binds];
  if (Array.isArray(host.Mounts) && host.Mounts.length) hostConfig.Mounts = host.Mounts.map((item) => ({ ...item }));
  if (Array.isArray(host.ExtraHosts) && host.ExtraHosts.length) hostConfig.ExtraHosts = [...host.ExtraHosts];
  if (Array.isArray(host.Dns) && host.Dns.length) hostConfig.Dns = [...host.Dns];
  if (Array.isArray(host.DnsOptions) && host.DnsOptions.length) hostConfig.DnsOptions = [...host.DnsOptions];
  if (Array.isArray(host.DnsSearch) && host.DnsSearch.length) hostConfig.DnsSearch = [...host.DnsSearch];
  if (Array.isArray(host.CapAdd) && host.CapAdd.length) hostConfig.CapAdd = [...host.CapAdd];
  if (Array.isArray(host.CapDrop) && host.CapDrop.length) hostConfig.CapDrop = [...host.CapDrop];
  if (Array.isArray(host.SecurityOpt) && host.SecurityOpt.length) hostConfig.SecurityOpt = [...host.SecurityOpt];
  if (Array.isArray(host.GroupAdd) && host.GroupAdd.length) hostConfig.GroupAdd = [...host.GroupAdd];
  if (Array.isArray(host.Devices) && host.Devices.length) hostConfig.Devices = host.Devices.map((item) => ({ ...item }));
  if (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length) hostConfig.DeviceRequests = host.DeviceRequests.map((item) => ({ ...item }));
  if (Number.isFinite(Number(host.ShmSize)) && Number(host.ShmSize) > 0) hostConfig.ShmSize = Number(host.ShmSize);
  if (typeof host.IpcMode === 'string' && host.IpcMode) hostConfig.IpcMode = host.IpcMode;
  if (typeof host.PidMode === 'string' && host.PidMode) hostConfig.PidMode = host.PidMode;
  if (host.Privileged === true) hostConfig.Privileged = true;
  if (isPlainObject(host.RestartPolicy) && Object.keys(host.RestartPolicy).length) hostConfig.RestartPolicy = { ...host.RestartPolicy };
  if (isPlainObject(host.LogConfig) && Object.keys(host.LogConfig).length) hostConfig.LogConfig = { ...host.LogConfig };
  if (typeof host.NetworkMode === 'string' && host.NetworkMode && !/^(host|container:)/i.test(host.NetworkMode)) {
    hostConfig.NetworkMode = host.NetworkMode;
  }

  const containerName = typeof options?.containerName === 'string' && options.containerName
    ? options.containerName
    : cloneContainerName(sourceName);
  const role = typeof options?.role === 'string' && options.role ? options.role : 'clone';
  const instanceName = typeof options?.instanceName === 'string' && options.instanceName
    ? options.instanceName
    : cloneFriendlyInstanceName(sourceName);

  labels['a0.launcher.role'] = role;
  labels['a0.launcher.instanceName'] = instanceName;
  if (options?.migrationSource === true) {
    labels['a0.launcher.migratedFromContainerId'] = String(containerId || '');
    labels['a0.launcher.migratedAt'] = nowIso();
  }

  const createOptions = {
    name: containerName,
    Image: cloneImageRef,
    Labels: labels,
    HostConfig: stripWorkspaceMounts(hostConfig)
  };

  setIfPresent(createOptions, 'Env', Array.isArray(config.Env) ? [...config.Env] : null);
  setIfPresent(createOptions, 'Cmd', Array.isArray(config.Cmd) ? [...config.Cmd] : config.Cmd);
  setIfPresent(createOptions, 'Entrypoint', Array.isArray(config.Entrypoint) ? [...config.Entrypoint] : config.Entrypoint);
  setIfPresent(createOptions, 'WorkingDir', typeof config.WorkingDir === 'string' ? config.WorkingDir : '');
  setIfPresent(createOptions, 'User', typeof config.User === 'string' ? config.User : '');
  setIfPresent(createOptions, 'ExposedPorts', exposedPorts);
  setIfPresent(createOptions, 'Volumes', isPlainObject(config.Volumes) ? { ...config.Volumes } : null);
  setIfPresent(createOptions, 'Healthcheck', isPlainObject(config.Healthcheck) ? { ...config.Healthcheck } : null);
  if (typeof config.Tty === 'boolean') createOptions.Tty = config.Tty;
  if (typeof config.OpenStdin === 'boolean') createOptions.OpenStdin = config.OpenStdin;
  if (typeof config.StdinOnce === 'boolean') createOptions.StdinOnce = config.StdinOnce;
  if (typeof config.AttachStdin === 'boolean') createOptions.AttachStdin = config.AttachStdin;
  if (typeof config.AttachStdout === 'boolean') createOptions.AttachStdout = config.AttachStdout;
  if (typeof config.AttachStderr === 'boolean') createOptions.AttachStderr = config.AttachStderr;
  if (typeof config.StopSignal === 'string' && config.StopSignal) createOptions.StopSignal = config.StopSignal;
  if (Number.isFinite(Number(config.StopTimeout))) createOptions.StopTimeout = Math.max(0, Math.floor(Number(config.StopTimeout)));

  const workspaceStorage = await resolveWorkspaceStorage({
    preferences: storagePreferences || await stateStore.readStoragePreferences(),
    override: options?.storage || null,
    instanceName,
    containerName
  });
  applyWorkspaceStorage(createOptions, workspaceStorage, { docker: options?.docker || null });

  return createOptions;
}

function effectiveRetentionCount(policy) {
  const keepCount = Number.isFinite(Number(policy?.keepCount)) ? Number(policy.keepCount) : 1;
  // Safety baseline: keep at least one previous instance for rollback.
  return Math.max(1, Math.min(20, Math.floor(keepCount)));
}

async function setRetentionPolicy(keepCount) {
  requireNoRunningOperation();
  const kc = assertKeepCount(keepCount);
  const policy = await stateStore.writeRetentionPolicy({ keepCount: kc });
  await refreshDockerManager({ forceRefresh: false });
  return policy;
}

async function setPortPreferences(portPreferences) {
  requireNoRunningOperation();
  const prefs = await stateStore.writePortPreferences(portPreferences);
  await refreshDockerManager({ forceRefresh: false });
  return prefs;
}

async function setStoragePreferences(storagePreferences) {
  requireNoRunningOperation();
  const prefs = await stateStore.writeStoragePreferences(storagePreferences);
  if (_cachedState) {
    _cachedState = { ..._cachedState, storagePreferences: prefs };
    events.emit('state', _cachedState);
  }
  return prefs;
}

async function setInstanceDefaults(instanceDefaults) {
  const defaults = await stateStore.writeInstanceDefaults(instanceDefaults);
  if (_cachedState) {
    _cachedState = { ..._cachedState, instanceDefaults: defaults };
    events.emit('state', _cachedState);
  }
  return defaults;
}

function assertRuntimeEndpointId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    const err = new Error('Invalid runtime endpoint');
    err.code = 'INVALID_RUNTIME_ENDPOINT';
    throw err;
  }
  return id;
}

async function selectRuntimeEndpoint(id) {
  const endpointId = assertRuntimeEndpointId(id);
  const imageRepo = getBackendImageRepo();
  const docker = await getManagedDocker(imageRepo, { forceRefresh: true });
  const env = await docker.getEnvironment();
  const candidates = Array.isArray(env?.runtimeCandidates) ? env.runtimeCandidates : [];
  const candidate = candidates.find((item) => item?.id === endpointId && item.available === true);

  if (!candidate) {
    const err = new Error('Selected runtime is not available.');
    err.code = 'RUNTIME_ENDPOINT_UNAVAILABLE';
    throw err;
  }

  const preference = await stateStore.writeRuntimeEndpointPreference({
    id: candidate.id,
    dockerHost: candidate.dockerHost,
    label: candidate.label,
    provider: candidate.provider
  });
  resetDocker();
  await refreshDockerManager({ forceRefresh: true }).catch(() => {});
  return preference;
}

async function provisionRuntime() {
  requireNoRunningOperation();
  const opId = beginOperation('runtime_setup', null);
  let runtimeAssessment = null;
  const reportRuntimeProgress = (message, progress = null) => {
    updateOperationProgress(runtimeSetupProgressPatch(runtimeAssessment, message, progress));
  };
  const finishRuntimeFollowup = async (result, assessment) => {
    if (!result || typeof result !== 'object' || typeof result.detail !== 'string') return false;
    await markRuntimeSetupResume(assessment);
    resetDocker();
    updateOperationProgress(runtimeSetupProgressPatch(assessment, result.detail, 100, 'completed'));
    finishOperation('completed', null);
    return true;
  };

  (async () => {
    const controller = new AbortController();
    _abortControllers.set(opId, controller);

    try {
      const provisioner = await getRuntimeProvisioner();
      if (!provisioner) {
        const err = new Error('Automatic Runtime Setup is not available on this system.');
        err.code = 'RUNTIME_UNSUPPORTED';
        throw err;
      }

      updateOperationProgress(runtimeSetupProgressPatch(null, 'Checking runtime', null));
      const assessment = await provisioner.assess();
      runtimeAssessment = assessment;
      updateOperationProgress(runtimeSetupProgressPatch(assessment, assessment?.detail || 'Checking runtime', null));

      if (assessment?.state === 'ready') {
        await clearRuntimeSetupResume();
        updateOperationProgress(runtimeSetupProgressPatch(assessment, 'Runtime ready', 100, 'completed'));
        finishOperation('completed', null);
        resetDocker();
        return;
      }

      if (assessment?.state === 'engine_stopped') {
        const result = await provisioner.start({
          signal: controller.signal,
          onProgress: reportRuntimeProgress
        });
        if (await finishRuntimeFollowup(result, assessment)) return;
      } else if (assessment?.state === 'not_provisioned' || assessment?.state === 'needs_group_membership') {
        const result = await provisioner.provision({
          signal: controller.signal,
          onProgress: reportRuntimeProgress
        });
        if (await finishRuntimeFollowup(result, assessment)) return;
      } else if (assessment?.state === 'needs_relogin') {
        const err = new Error(assessment.detail || 'Log out and back in once, then return here.');
        err.code = 'RUNTIME_NEEDS_RELOGIN';
        throw err;
      } else if (assessment?.state === 'manual_install') {
        const err = new Error(assessment.detail || 'Manual Docker installation is required.');
        err.code = 'RUNTIME_MANUAL_INSTALL';
        err.details = {
          packageManager: assessment.packageManager,
          packages: assessment.manualPackages,
          manualCommand: assessment.manualCommand
        };
        throw err;
      } else {
        const err = new Error(assessment?.detail || 'Automatic Runtime Setup is not available on this system.');
        err.code = 'RUNTIME_UNSUPPORTED';
        throw err;
      }

      resetDocker();
      await clearRuntimeSetupResume();
      updateOperationProgress(runtimeSetupProgressPatch(assessment, 'Runtime ready', 100, 'completed'));
      finishOperation('completed', null);
    } catch (error) {
      const message = mapDockerInterfaceErrorToUiMessage(error) || error?.message || 'Runtime Setup failed';
      updateOperationProgress(runtimeSetupProgressPatch(runtimeAssessment, message, null, 'failed'));
      finishOperation('failed', message);
    } finally {
      _abortControllers.delete(opId);
      resetDocker();
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('provisionRuntime.unhandled', error, { opId });
  });

  return { opId };
}

async function resumeRuntimeSetupIfPending() {
  const marker = await stateStore.readRuntimeSetupResume().catch(() => null);
  if (!marker?.pending) return { resumed: false, reason: 'not_pending' };
  if (_currentOperation?.status === 'running') return { resumed: false, reason: 'operation_running' };

  const state = await refreshDockerManager({ forceRefresh: true });
  const runtime = state?.runtime;
  if (!runtime || runtime.state === 'ready') {
    await clearRuntimeSetupResume();
    return { resumed: false, reason: 'runtime_ready' };
  }

  if (!runtime.canProvision || runtime.requiresAdmin === true || !['install', 'start'].includes(runtime.action)) {
    return { resumed: false, reason: 'waiting_for_user', runtime };
  }

  return { resumed: true, ...(await provisionRuntime()) };
}

async function addRemoteInstance(remoteInstance) {
  const saved = await stateStore.writeRemoteInstance(remoteInstance);
  if (_cachedState) {
    const remoteInstances = await stateStore.readRemoteInstances();
    _cachedState = { ..._cachedState, remoteInstances: enrichRemoteInstancesWithHealth(remoteInstances, { forceRefresh: true }) };
    events.emit('state', _cachedState);
  }
  return saved;
}

async function deleteRemoteInstance(id) {
  const result = await stateStore.deleteRemoteInstance(id);
  if (_cachedState) {
    const remoteInstances = await stateStore.readRemoteInstances();
    _cachedState = { ..._cachedState, remoteInstances: enrichRemoteInstancesWithHealth(remoteInstances) };
    events.emit('state', _cachedState);
  }
  return result;
}

async function renameRemoteInstance(id, name) {
  const found = await getRemoteInstance(id);
  const saved = await stateStore.writeRemoteInstance({
    id: found.id,
    name,
    url: found.url
  });
  if (_cachedState) {
    const remoteInstances = await stateStore.readRemoteInstances();
    _cachedState = { ..._cachedState, remoteInstances: enrichRemoteInstancesWithHealth(remoteInstances) };
    events.emit('state', _cachedState);
  }
  return saved;
}

async function setRemoteInstanceColor(id, color) {
  const found = await getRemoteInstance(id);
  const saved = await stateStore.writeRemoteInstance({
    id: found.id,
    name: found.name,
    url: found.url,
    color
  });
  if (_cachedState) {
    const remoteInstances = await stateStore.readRemoteInstances();
    _cachedState = { ..._cachedState, remoteInstances: enrichRemoteInstancesWithHealth(remoteInstances) };
    events.emit('state', _cachedState);
  }
  return saved;
}

async function getRemoteInstance(id) {
  const cleanId = String(id || '').trim();
  const remoteInstances = await stateStore.readRemoteInstances();
  const found = remoteInstances.find((item) => item.id === cleanId) || null;
  if (!found) {
    const err = new Error('Remote instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }
  return found;
}

async function createAndStartActiveContainer(docker, imageRepo, tag, portPreferences, activationOptions = null, storagePreferences = null) {
  const activeName = retention.getActiveContainerName(imageRepo);
  const imageRef = imageRefForTag(imageRepo, tag);

  const prefs = portPreferences && typeof portPreferences === 'object'
    ? portPreferences
    : await stateStore.readPortPreferences();

  const toPort = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const p = Math.floor(n);
    if (p <= 0 || p > 65535) return fallback;
    return p;
  };

  const hostPortUi = toPort(prefs?.ui, 8880);
  const hostPortSsh = toPort(prefs?.ssh, 55022);

  const requestedMappings = Array.isArray(activationOptions?.portMappings) && activationOptions.portMappings.length
    ? activationOptions.portMappings
    : [
        { hostPort: hostPortUi, containerPort: 80, key: '80/tcp' },
        { hostPort: hostPortSsh, containerPort: 22, key: '22/tcp' }
      ];
  const mappings = await settlePortMappings(requestedMappings);

  const { exposedPorts, portBindings } = buildPortExposure(mappings);

  const instanceName = sanitizeInstanceName(activationOptions?.instanceName, sanitizeInstanceName(`agent-zero-${tag}`));
  const uiMapping = preferredUiMapping(mappings);
  const sshMapping = mappings.find((m) => Number(m.containerPort) === 22) || null;
  const portMapLabel = mappings.map((m) => `${m.hostPort}:${m.containerPort}`).join(',');

  const createOptions = {
    name: activeName,
    Image: imageRef,
    ExposedPorts: exposedPorts,
    Labels: {
      'a0.launcher.managed': 'true',
      'a0.launcher.role': 'active',
      'a0.launcher.versionTag': tag,
      'a0.launcher.instanceName': instanceName,
      'a0.launcher.port.map': portMapLabel,
      'a0.launcher.port.ui': String(uiMapping?.hostPort ?? ''),
      'a0.launcher.port.ssh': String(sshMapping?.hostPort ?? '')
    },
    HostConfig: {
      PortBindings: portBindings
    }
  };

  const workspaceStorage = await resolveWorkspaceStorage({
    preferences: storagePreferences || await stateStore.readStoragePreferences(),
    override: activationOptions?.storage || null,
    instanceName,
    containerName: activeName
  });
  applyWorkspaceStorage(createOptions, workspaceStorage, { docker });

  if (Array.isArray(activationOptions?.env) && activationOptions.env.length) {
    createOptions.Env = activationOptions.env;
  }

  const created = await docker.createContainer(createOptions);
  const containerId = created?.containerId;
  if (!containerId) {
    const err = new Error('Failed to create container');
    err.code = 'CREATE_FAILED';
    throw err;
  }

  await docker.startContainer(containerId);
  return { containerId, name: activeName };
}

function buildPortExposure(mappings) {
  const exposedPorts = {};
  const portBindings = portBindingsFromMappings(mappings);
  for (const key of Object.keys(portBindings)) {
    exposedPorts[key] = {};
  }
  return { exposedPorts, portBindings };
}

function preferredUiMapping(mappings) {
  const candidates = Array.isArray(mappings) ? mappings : [];
  const preferredContainerPorts = [80, 7860, 3000, 8080, 5000, 9000, 9001, 9002];
  for (const port of preferredContainerPorts) {
    const found = candidates.find((mapping) => Number(mapping.containerPort) === port);
    if (found) return found;
  }
  return candidates.find((mapping) => Number(mapping.containerPort) !== 22) || candidates[0] || null;
}

function developerContainerName(instanceName) {
  const suffix = Date.now().toString(36);
  const base = sanitizeInstanceName(`a0-dev-${instanceName || 'image'}`, 'a0-dev-image').slice(0, 48);
  return sanitizeInstanceName(`${base}-${suffix}`, `a0-dev-${suffix}`);
}

function managedInstanceContainerName(tag, instanceName) {
  const suffix = Date.now().toString(36);
  const baseName = instanceName || `agent-zero-${tag || 'instance'}`;
  const base = sanitizeInstanceName(`a0-inst-${baseName}`, 'a0-inst').slice(0, 48);
  return sanitizeInstanceName(`${base}-${suffix}`, `a0-inst-${suffix}`);
}

function shouldKeepCreatedManagedInstanceOnError(error, createdNew) {
  return error?.code === 'UI_NOT_READY' && !!createdNew?.containerId;
}

async function createAndStartManagedInstanceContainer(docker, imageRepo, tag, activationOptions = null, storagePreferences = null) {
  const imageRef = imageRefForTag(imageRepo, tag);
  const requestedMappings = Array.isArray(activationOptions?.portMappings) && activationOptions.portMappings.length
    ? activationOptions.portMappings
    : parsePortMappings('0:80');
  const mappings = await settlePortMappings(requestedMappings);
  const { exposedPorts, portBindings } = buildPortExposure(mappings);
  const uiMapping = preferredUiMapping(mappings);
  const sshMapping = mappings.find((mapping) => Number(mapping.containerPort) === 22) || null;
  const instanceName = sanitizeInstanceName(activationOptions?.instanceName, sanitizeInstanceName(`agent-zero-${tag}`));
  const containerName = managedInstanceContainerName(tag, instanceName);
  const portMapLabel = mappings.map((m) => `${m.hostPort}:${m.containerPort}`).join(',');

  const createOptions = {
    name: containerName,
    Image: imageRef,
    ExposedPorts: exposedPorts,
    Labels: {
      'a0.launcher.managed': 'true',
      'a0.launcher.role': 'instance',
      'a0.launcher.versionTag': tag,
      'a0.launcher.instanceName': instanceName,
      'a0.launcher.imageRepo': imageRepo,
      'a0.launcher.imageRef': imageRef,
      'a0.launcher.port.map': portMapLabel,
      'a0.launcher.port.ui': String(uiMapping?.hostPort ?? ''),
      'a0.launcher.port.ssh': String(sshMapping?.hostPort ?? '')
    },
    HostConfig: {
      PortBindings: portBindings
    }
  };

  const workspaceStorage = await resolveWorkspaceStorage({
    preferences: storagePreferences || await stateStore.readStoragePreferences(),
    override: activationOptions?.storage || null,
    instanceName,
    containerName
  });
  applyWorkspaceStorage(createOptions, workspaceStorage, { docker });

  if (Array.isArray(activationOptions?.env) && activationOptions.env.length) {
    createOptions.Env = activationOptions.env;
  }

  const created = await docker.createContainer(createOptions);
  const containerId = created?.containerId;
  if (!containerId) {
    const err = new Error('Failed to create container');
    err.code = 'CREATE_FAILED';
    throw err;
  }

  await docker.startContainer(containerId);
  return { containerId, name: containerName };
}

async function createAndStartDeveloperContainer(docker, options, storagePreferences = null) {
  const requestedMappings = Array.isArray(options?.portMappings) ? options.portMappings : parsePortMappings('0:80');
  const mappings = await settlePortMappings(requestedMappings);
  const { exposedPorts, portBindings } = buildPortExposure(mappings);
  const uiMapping = preferredUiMapping(mappings);
  const sshMapping = mappings.find((mapping) => Number(mapping.containerPort) === 22) || null;
  const containerName = developerContainerName(options?.instanceName);
  const portMapLabel = mappings.map((m) => `${m.hostPort}:${m.containerPort}`).join(',');

  const createOptions = {
    name: containerName,
    Image: options.imageRef,
    ExposedPorts: exposedPorts,
    Labels: {
      'a0.launcher.managed': 'true',
      'a0.launcher.role': 'developer',
      'a0.launcher.versionTag': options.tag,
      'a0.launcher.instanceName': options.instanceName,
      'a0.launcher.imageRepo': options.imageRepo,
      'a0.launcher.imageRef': options.imageRef,
      'a0.launcher.port.map': portMapLabel,
      'a0.launcher.port.ui': String(uiMapping?.hostPort ?? ''),
      'a0.launcher.port.ssh': String(sshMapping?.hostPort ?? '')
    },
    HostConfig: {
      PortBindings: portBindings
    }
  };

  if (Array.isArray(options?.env) && options.env.length) {
    createOptions.Env = options.env;
  }
  if (Array.isArray(options?.binds) && options.binds.length) {
    createOptions.HostConfig.Binds = options.binds;
  }

  const workspaceStorage = await resolveWorkspaceStorage({
    preferences: storagePreferences || await stateStore.readStoragePreferences(),
    override: options?.storage || null,
    instanceName: options.instanceName,
    containerName
  });
  applyWorkspaceStorage(createOptions, workspaceStorage, { skipIfCustom: true, docker });

  const created = await docker.createContainer(createOptions);
  const containerId = created?.containerId;
  if (!containerId) {
    const err = new Error('Failed to create container');
    err.code = 'CREATE_FAILED';
    throw err;
  }

  await docker.startContainer(containerId);
  return { containerId, name: containerName };
}

async function enforceRetention(docker, imageRepo, policy) {
  const keep = effectiveRetentionCount(policy);
  const containers = await docker.listContainers(imageRepo);

  const retained = [];
  for (const c of containers || []) {
    const name = c?.containerName || '';
    const parsed = retention.parseRetainedContainerName(name);
    if (!parsed) continue;
    retained.push({ containerId: c?.containerId || '', retainedAt: parsed.retainedAt });
  }

  retained.sort((a, b) => {
    const ams = isoToMs(a.retainedAt);
    const bms = isoToMs(b.retainedAt);
    if (Number.isFinite(bms) && Number.isFinite(ams)) return bms - ams;
    return String(b.retainedAt).localeCompare(String(a.retainedAt));
  });

  const toDelete = retained.slice(keep);
  for (const r of toDelete) {
    if (!r.containerId) continue;
    try {
      await docker.deleteContainer(r.containerId, { force: true });
    } catch {
      // best-effort retention cleanup
    }
  }
}

async function installOrSync(tag, options = {}) {
  const imageRepo = getBackendImageRepo();
  const t = assertTagAllowedForInstall(tag);
  const operationType = options?.operationType === 'update' ? 'update' : 'install';
  const presentation = options?.presentation === 'toast' ? 'toast' : 'modal';

  requireNoRunningOperation();
  const opId = beginOperation(operationType, t, { presentation });

  (async () => {
    let docker;
    try {
      updateOperationProgress({
        message: operationType === 'update' ? 'Checking for updates' : 'Checking availability',
        progress: null
      });

      docker = await getManagedDocker(imageRepo);
      const cache = await stateStore.readInstallabilityCache();
      const entries = cache?.entries && typeof cache.entries === 'object' ? cache.entries : {};

      const nowMs = Date.now();
      const existing = entries[t];
      const status = existing?.status || 'unknown';
      const checkedAtMs = isoToMs(existing?.checkedAt);
      const recheckAfterMs = isoToMs(existing?.recheckAfter);

      let needCheck = true;
      if (status === 'installable' && Number.isFinite(checkedAtMs) && nowMs - checkedAtMs < 24 * 60 * 60 * 1000) {
        needCheck = false;
      }
      if (status === 'not_yet_available' && Number.isFinite(recheckAfterMs) && nowMs < recheckAfterMs) {
        const err = new Error('Not yet available');
        err.code = 'NOT_YET_AVAILABLE';
        throw err;
      }

      if (needCheck) {
        const digestInfo = await docker.getRemoteDigest(imageRepo, t);
        const exists = !!digestInfo?.exists;
        if (!exists) {
          entries[t] = {
            status: 'not_yet_available',
            checkedAt: nowIso(),
            recheckAfter: new Date(nowMs + 15 * 60 * 1000).toISOString(),
            digest: null,
            contentType: null
          };
          await stateStore.writeInstallabilityCache({ ...cache, entries, updatedAt: nowIso() });
          const err = new Error('Not yet available');
          err.code = 'NOT_YET_AVAILABLE';
          throw err;
        }

        entries[t] = {
          status: 'installable',
          checkedAt: nowIso(),
          recheckAfter: null,
          digest: digestInfo?.digest || null,
          contentType: digestInfo?.contentType || null
        };
        await stateStore.writeInstallabilityCache({ ...cache, entries, updatedAt: nowIso() });
      }

      const controller = new AbortController();
      _abortControllers.set(opId, controller);
      updateOperationProgress({ message: 'Downloading', progress: null, downloadProgress: 0, extractProgress: 0, canCancel: true });

      const imageRef = imageRefForTag(imageRepo, t);
      const result = await docker.pullImage(imageRef, {
        signal: controller.signal,
        onProgress: (evt) => {
          const dl =
            typeof evt?.downloadProgress === 'number' && Number.isFinite(evt.downloadProgress) ? evt.downloadProgress : null;
          const ex =
            typeof evt?.extractProgress === 'number' && Number.isFinite(evt.extractProgress) ? evt.extractProgress : null;

          const message =
            typeof dl === 'number' && dl < 100 ? 'Downloading' : typeof ex === 'number' && ex < 100 ? 'Extracting' : 'Downloading';

          updateOperationProgress({ progress: dl, downloadProgress: dl, extractProgress: ex, message, canCancel: true });
        }
      });
      _abortControllers.delete(opId);

      if (result?.status === 'aborted_client') {
        finishOperation('canceled', 'Canceled');
      } else {
        finishOperation('completed', null);
        updateOperationProgress({ progress: 100, downloadProgress: 100, extractProgress: 100, message: 'Completed' });
      }
    } catch (error) {
      const message =
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'NOT_YET_AVAILABLE'
          ? 'This version is not available yet. Please try again later.'
          : '') ||
        (operationType === 'update' ? 'Update failed' : 'Install failed');
      finishOperation('failed', message, error?.code || null);
    } finally {
      _abortControllers.delete(opId);
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function removeInstalledImage(tag) {
  const imageRepo = getBackendImageRepo();
  const t = assertTagAllowedForActivate(tag);
  requireNoRunningOperation();

  const docker = await getManagedDocker(imageRepo);
  const localImages = await docker.listLocalImages(imageRepo);
  const target = (localImages || []).find((img) => img?.tag === t) || null;
  if (!target?.imageRef) {
    throw makeDockerManagerError('NOT_INSTALLED', 'This install is not available locally.');
  }

  try {
    await docker.removeLocalImage(target.imageRef, { force: false });
    await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    return { removed: true, tag: t };
  } catch (error) {
    if (error?.code === 'CONFLICT') {
      throw makeDockerManagerError('IMAGE_IN_USE', 'This install is still used by an Instance. Delete the Instance first, then remove the install.');
    }
    throw error;
  }
}

async function stopActiveInstance() {
  const imageRepo = getBackendImageRepo();

  requireNoRunningOperation();
  const opId = beginOperation('stop', null);

  (async () => {
    try {
      updateOperationProgress({ message: 'Stopping', progress: null });
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (!active || !active.containerId) {
        const err = new Error('No active instance');
        err.code = 'NO_ACTIVE_INSTANCE';
        throw err;
      }

      const state = (active.state || '').toLowerCase();
      if (state === 'running') {
        await docker.stopContainer(active.containerId, { t: 10 });
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Stopped' });
    } catch (error) {
      const message = mapDockerInterfaceErrorToUiMessage(error) || 'Stop failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function stopLocalInstance(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);

  return enqueueContainerOperation({
    type: 'stop',
    containerId: id,
    message: 'Stopping',
    run: async (targetId) => {
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === targetId) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const state = (target.state || '').toLowerCase();
      if (state === 'running') {
        await docker.stopContainer(target.containerId, { t: 10 });
      }
    }
  });
}

async function startLocalInstance(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);

  return enqueueContainerOperation({
    type: 'start',
    containerId: id,
    message: 'Starting',
    run: async (targetId) => {
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === targetId) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const state = (target.state || '').toLowerCase();
      if (state !== 'running') {
        await docker.startContainer(target.containerId);
      }
    }
  });
}

async function cloneLocalInstance(containerId, options = {}) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const workspaceSelection = normalizeCloneWorkspaceSelection(options?.workspaceCategories);

  requireNoRunningOperation();
  const opId = beginOperation('clone_instance', null);

  (async () => {
    /** @type {any} */
    let docker = null;
    let cloneImageRef = '';
    let createdContainerId = '';
    let cloneHeadline = cloneOperationHeadline('');

    try {
      updateOperationProgress({ headline: cloneHeadline, message: 'Preparing clone', progress: null });
      docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === id) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const targetName = target.instanceName || target.containerName || String(target.containerId || '').slice(0, 12) || 'instance';
      cloneHeadline = cloneOperationHeadline(targetName);
      updateOperationProgress({ headline: cloneHeadline, message: 'Preparing clone', progress: null });
      const inspect = await docker.inspectContainer(target.containerId);
      cloneHeadline = cloneOperationHeadline(sourceInstanceNameFromInspect(inspect, targetName));
      cloneImageRef = cloneImageRefForContainer(target.containerId);

      updateOperationProgress({ headline: cloneHeadline, message: 'Snapshotting container', progress: null });
      await docker.commitContainer(target.containerId, cloneImageRef, {
        pause: true,
        comment: 'Agent Zero Launcher instance clone',
        author: 'Agent Zero Launcher'
      });

      updateOperationProgress({ headline: cloneHeadline, message: 'Creating clone on open ports', progress: null });
      const createOptions = await buildCloneCreateOptions(
        inspect,
        target.containerId,
        cloneImageRef,
        await stateStore.readStoragePreferences(),
        {
          workspaceCategories: workspaceSelection,
          docker
        }
      );
      const created = await docker.createContainer(createOptions);
      createdContainerId = created?.containerId || '';
      if (!createdContainerId) {
        const err = new Error('Failed to create container');
        err.code = 'CREATE_FAILED';
        throw err;
      }

      if (!cloneWorkspaceSelectionIsEmpty(workspaceSelection)) {
        const categoryCount = selectedCloneWorkspaceCategoryIds(workspaceSelection).length;
        const message = cloneWorkspaceSelectionIsAll(workspaceSelection)
          ? 'Copying /a0/usr data'
          : `Copying selected /a0/usr data (${categoryCount})`;
        updateOperationProgress({ headline: cloneHeadline, message, progress: null });
        await copySelectedWorkspaceData(
          docker,
          target.containerId,
          createdContainerId,
          workspaceSelection,
          (copyMessage) => updateOperationProgress({ headline: cloneHeadline, message: copyMessage, progress: null })
        );
      }

      updateOperationProgress({ headline: cloneHeadline, message: 'Starting clone', progress: null });
      await docker.startContainer(createdContainerId);

      finishOperation('completed', null);
      updateOperationProgress({ headline: cloneHeadline, progress: 100, message: 'Cloned' });
    } catch (error) {
      logDockerManagerError('cloneLocalInstance', error, { opId, containerId: id, cloneImageRef });
      try {
        if (docker && createdContainerId) {
          await docker.deleteContainer(createdContainerId, { force: true });
        }
      } catch {
        // ignore cleanup failure
      }
      try {
        if (docker && cloneImageRef) {
          await docker.removeLocalImage(cloneImageRef);
        }
      } catch {
        // ignore cleanup failure
      }

      const message = mapDockerInterfaceErrorToUiMessage(error) || error?.message || 'Clone failed';
      finishOperation('failed', message, error?.code || null);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('cloneLocalInstance.unhandled', error, { opId, containerId: id });
  });

  return { opId };
}

async function migrateLocalInstanceStorage(containerId, options = {}) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const storageOverride = normalizeStorageOverride(options);
  if (storageOverride?.mode === STORAGE_MODE_EPHEMERAL) {
    const err = new Error('Persisting /a0/usr data requires persistent storage.');
    err.code = 'INVALID_STORAGE_MODE';
    throw err;
  }

  requireNoRunningOperation();
  const opId = beginOperation('migrate_workspace', null);

  (async () => {
    /** @type {any} */
    let docker = null;
    let cloneImageRef = '';
    let createdContainerId = '';
    let migrationHeadline = 'Persisting /a0/usr data';

    try {
      updateOperationProgress({ headline: migrationHeadline, message: 'Preparing migration', progress: null });
      docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === id) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const targetName = target.instanceName || target.containerName || String(target.containerId || '').slice(0, 12) || 'instance';
      const inspect = await docker.inspectContainer(target.containerId);
      const sourceStorage = workspaceStorageFromInspect(inspect);
      if (sourceStorage?.persistent) {
        const err = new Error('This instance already has persistent workspace storage.');
        err.code = 'WORKSPACE_ALREADY_PERSISTENT';
        throw err;
      }

      const friendlyName = sourceInstanceNameFromInspect(inspect, targetName);
      const sourceContainerName = target.containerName || containerNameFromInspect(inspect) || targetName;
      migrationHeadline = `Persisting ${friendlyName || 'instance'}`;
      cloneImageRef = cloneImageRefForContainer(target.containerId);

      updateOperationProgress({ headline: migrationHeadline, message: 'Snapshotting legacy instance', progress: null });
      await docker.commitContainer(target.containerId, cloneImageRef, {
        pause: true,
        comment: 'Agent Zero Launcher workspace migration',
        author: 'Agent Zero Launcher'
      });

      updateOperationProgress({ headline: migrationHeadline, message: 'Creating persistent replacement', progress: null });
      const createOptions = await buildCloneCreateOptions(
        inspect,
        target.containerId,
        cloneImageRef,
        await stateStore.readStoragePreferences(),
        {
          role: 'instance',
          instanceName: friendlyName,
          containerName: migratedInstanceContainerName(friendlyName),
          migrationSource: true,
          preserveSettledPorts: true,
          storage: storageOverride,
          docker
        }
      );
      const replacementContainerName = createOptions.name || migratedInstanceContainerName(friendlyName);
      const created = await docker.createContainer(createOptions);
      createdContainerId = created?.containerId || '';
      if (!createdContainerId) {
        const err = new Error('Failed to create persistent replacement');
        err.code = 'CREATE_FAILED';
        throw err;
      }

      if (typeof docker.copyContainerPathToContainer === 'function') {
        updateOperationProgress({ headline: migrationHeadline, message: 'Copying workspace data', progress: null });
        const copied = await docker.copyContainerPathToContainer(
          target.containerId,
          WORKSPACE_MOUNT_TARGET,
          createdContainerId,
          '/a0'
        );
        if (copied?.copied === false) {
          updateOperationProgress({ headline: migrationHeadline, message: 'No legacy workspace files found', progress: null });
        }
      }

      updateOperationProgress({ headline: migrationHeadline, message: 'Starting persistent replacement', progress: null });
      await docker.startContainer(createdContainerId);

      updateOperationProgress({ headline: migrationHeadline, message: 'Waiting for replacement UI', progress: null });
      const waitRes = await waitForUiReachable(docker, createdContainerId, {
        timeoutMs: UI_READY_TIMEOUT_MS,
        intervalMs: 450,
        attemptTimeoutMs: UI_READY_ATTEMPT_TIMEOUT_MS,
        onTick: (seconds) => {
          const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
          updateOperationProgress({ headline: migrationHeadline, message: `Waiting for replacement UI${s}`, progress: null });
        }
      });
      if (!waitRes.ok) {
        const err = new Error('Persistent replacement started, but the Agent Zero UI is not reachable yet.');
        err.code = 'UI_NOT_READY';
        throw err;
      }

      updateOperationProgress({
        workspaceMigration: {
          sourceName: friendlyName || sourceContainerName || 'legacy instance',
          sourceContainerName,
          replacementName: friendlyName || replacementContainerName || 'persistent instance',
          replacementContainerName,
          mountTarget: WORKSPACE_MOUNT_TARGET
        }
      });
      finishOperation('completed', null);
      updateOperationProgress({ headline: migrationHeadline, progress: 100, message: 'Persisted' });
    } catch (error) {
      logDockerManagerError('migrateLocalInstanceStorage', error, { opId, containerId: id, cloneImageRef });
      try {
        if (docker && createdContainerId) {
          await docker.deleteContainer(createdContainerId, { force: true });
        }
      } catch {
        // ignore cleanup failure
      }
      try {
        if (docker && cloneImageRef) {
          await docker.removeLocalImage(cloneImageRef);
        }
      } catch {
        // ignore cleanup failure
      }

      const message =
        (error && typeof error === 'object' && error.code === 'WORKSPACE_ALREADY_PERSISTENT' && error.message) ||
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        error?.message ||
        'Persisting /a0/usr data failed';
      finishOperation('failed', message, error?.code || null);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('migrateLocalInstanceStorage.unhandled', error, { opId, containerId: id });
  });

  return { opId };
}

async function backupLocalInstance(containerId, outputPath) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const targetPath = assertHostZipPath(outputPath, 'write');

  requireNoRunningOperation();
  const opId = beginOperation('backup_workspace', null);

  (async () => {
    try {
      updateOperationProgress({ headline: 'Backing up /a0/usr', message: 'Preparing backup', progress: null });
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === id) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const sourceName = target.instanceName || target.containerName || id.slice(0, 12);
      updateOperationProgress({ headline: `Backing up ${sourceName || 'instance'}`, message: 'Reading /a0/usr data', progress: null });
      const result = await createAgentZeroBackupZip(docker, id, targetPath, { sourceName });

      finishOperation('completed', null);
      updateOperationProgress({
        headline: `Backed up ${sourceName || 'instance'}`,
        message: `Saved ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}`,
        progress: 100
      });
    } catch (error) {
      logDockerManagerError('backupLocalInstance', error, { opId, containerId: id, outputPath: targetPath });
      const message =
        (error && typeof error === 'object' && error.code === 'BACKUP_EMPTY' && error.message) ||
        (error && typeof error === 'object' && error.code === 'BACKUP_TOO_LARGE' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        error?.message ||
        'Backup failed';
      finishOperation('failed', message, error?.code || null);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('backupLocalInstance.unhandled', error, { opId, containerId: id });
  });

  return { opId };
}

async function restoreLocalInstance(containerId, inputPath) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const sourcePath = assertHostZipPath(inputPath, 'read');

  requireNoRunningOperation();
  const opId = beginOperation('restore_workspace', null);

  (async () => {
    try {
      updateOperationProgress({ headline: 'Restoring /a0/usr', message: 'Preparing restore', progress: null });
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === id) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const targetName = target.instanceName || target.containerName || id.slice(0, 12);
      updateOperationProgress({ headline: `Restoring ${targetName || 'instance'}`, message: 'Ensuring /a0/usr exists', progress: null });
      if (typeof docker.ensureContainerDirectory === 'function') {
        await docker.ensureContainerDirectory(id, WORKSPACE_MOUNT_TARGET);
      }

      updateOperationProgress({ headline: `Restoring ${targetName || 'instance'}`, message: 'Writing /a0/usr data', progress: null });
      const result = await restoreAgentZeroBackupZip(
        docker,
        id,
        sourcePath,
        (message) => updateOperationProgress({ headline: `Restoring ${targetName || 'instance'}`, message, progress: null })
      );

      finishOperation('completed', null);
      updateOperationProgress({
        headline: `Restored ${targetName || 'instance'}`,
        message: `Restored ${result.restoredFiles} file${result.restoredFiles === 1 ? '' : 's'}`,
        progress: 100
      });
    } catch (error) {
      logDockerManagerError('restoreLocalInstance', error, { opId, containerId: id, inputPath: sourcePath });
      const message =
        (error && typeof error === 'object' && error.code === 'INVALID_BACKUP_ARCHIVE' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        error?.message ||
        'Restore failed';
      finishOperation('failed', message, error?.code || null);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('restoreLocalInstance.unhandled', error, { opId, containerId: id });
  });

  return { opId };
}

async function renameLocalInstance(containerId, name) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getManagedDocker(imageRepo);
  const containers = await docker.listContainers(imageRepo);
  const target = (containers || []).find((c) => c && c.containerId === id) || null;

  if (!target || !target.containerId) {
    const err = new Error('Instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  const saved = await stateStore.writeLocalInstanceName(id, name);
  await refreshDockerManager({ forceRefresh: false }).catch(() => {});
  return { containerId: id, instanceName: saved.name };
}

async function setLocalInstanceColor(containerId, color) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getManagedDocker(imageRepo);
  const containers = await docker.listContainers(imageRepo);
  const target = (containers || []).find((c) => c && c.containerId === id) || null;

  if (!target || !target.containerId) {
    const err = new Error('Instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  const saved = await stateStore.writeLocalInstanceColor(id, color);
  await refreshDockerManager({ forceRefresh: false }).catch(() => {});
  return { containerId: id, color: saved.color || '' };
}

async function setLocalInstanceCredentials(containerId, credentials = {}) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getManagedDocker(imageRepo);
  const containers = await docker.listContainers(imageRepo);
  const target = (containers || []).find((c) => c && c.containerId === id) || null;

  if (!target || !target.containerId) {
    const err = new Error('Instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  const saved = await stateStore.writeLocalInstanceCredentials(id, credentials);
  await refreshDockerManager({ forceRefresh: false }).catch(() => {});
  return saved;
}

async function clearLocalInstanceCredentials(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getManagedDocker(imageRepo);
  const containers = await docker.listContainers(imageRepo);
  const target = (containers || []).find((c) => c && c.containerId === id) || null;

  if (!target || !target.containerId) {
    const err = new Error('Instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  await stateStore.deleteLocalInstanceCredentials(id);
  await refreshDockerManager({ forceRefresh: false }).catch(() => {});
  return { containerId: id, cleared: true };
}

async function getLocalInstanceCredentials(containerId) {
  const id = assertContainerId(containerId);
  return await stateStore.readLocalInstanceCredentials(id);
}

async function startActiveInstance() {
  const imageRepo = getBackendImageRepo();

  requireNoRunningOperation();
  const opId = beginOperation('start', null);

  (async () => {
    try {
      updateOperationProgress({ message: 'Starting', progress: null });
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (!active || !active.containerId) {
        const err = new Error('No active instance');
        err.code = 'NO_ACTIVE_INSTANCE';
        throw err;
      }

      const state = (active.state || '').toLowerCase();
      if (state !== 'running') {
        await docker.startContainer(active.containerId);
      }

      updateOperationProgress({ message: 'Starting (waiting for UI)', progress: null });
      const waitRes = await waitForUiReachable(docker, active.containerId, {
        timeoutMs: UI_READY_TIMEOUT_MS,
        intervalMs: 450,
        attemptTimeoutMs: UI_READY_ATTEMPT_TIMEOUT_MS,
        onTick: (seconds) => {
          const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
          updateOperationProgress({ message: `Starting (waiting for UI${s})`, progress: null });
        }
      });
      if (!waitRes.ok) {
        const err = new Error('Agent Zero UI is not reachable yet. Please wait and try Refresh.');
        err.code = 'UI_NOT_READY';
        throw err;
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Started' });
    } catch (error) {
      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        'Start failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function deleteRetainedInstance(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);

  requireNoRunningOperation();
  const opId = beginOperation('delete_instance', null);

  (async () => {
    try {
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (active && active.containerId === id) {
        const err = new Error('Cannot delete active instance');
        err.code = 'CANNOT_DELETE_ACTIVE';
        throw err;
      }

      const target = (containers || []).find((c) => c && c.containerId === id) || null;
      if (!target || !retention.parseRetainedContainerName(target.containerName || '')) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      await docker.deleteContainer(id, { force: true });
      await stateStore.deleteLocalInstanceName(id).catch(() => {});
      await stateStore.deleteLocalInstanceColor(id).catch(() => {});
      await stateStore.deleteLocalInstanceCredentials(id).catch(() => {});
      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Deleted' });
    } catch (error) {
      const message =
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'CANNOT_DELETE_ACTIVE'
          ? 'You cannot delete the active instance.'
          : '') ||
        'Delete failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function deleteLocalInstance(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);

  return enqueueContainerOperation({
    type: 'delete_instance',
    containerId: id,
    message: 'Deleting',
    run: async (targetId) => {
      const docker = await getManagedDocker(imageRepo);
      const containers = await docker.listContainers(imageRepo);
      const target = (containers || []).find((c) => c && c.containerId === targetId) || null;

      if (!target || !target.containerId) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      const cloneImageRef = typeof target?.labels?.['a0.launcher.cloneImageRef'] === 'string'
        ? target.labels['a0.launcher.cloneImageRef']
        : '';

      await docker.deleteContainer(target.containerId, { force: true });
      if (cloneImageRef && cloneImageRef.startsWith(`${CLONE_IMAGE_REPO}:`)) {
        await docker.removeLocalImage(cloneImageRef).catch(() => {});
      }
      await stateStore.deleteLocalInstanceName(target.containerId).catch(() => {});
      await stateStore.deleteLocalInstanceColor(target.containerId).catch(() => {});
      await stateStore.deleteLocalInstanceCredentials(target.containerId).catch(() => {});
    }
  });
}

async function updateToLatest(dataLossAck) {
  const imageRepo = getBackendImageRepo();
  const githubRepo = getBackendGithubRepo();
  const ack = assertDataLossAck(dataLossAck);

  requireNoRunningOperation();
  const opId = beginOperation('update', null);

  (async () => {
    /** @type {any} */
    let docker = null;
    let policy = null;
    let keep = 0;
    let portPreferences = null;

    let retainedFromActive = null;
    let createdNew = null;

    try {
      docker = await getManagedDocker(imageRepo);
      policy = await stateStore.readRetentionPolicy();
      keep = effectiveRetentionCount(policy);
      portPreferences = await stateStore.readPortPreferences();

      updateOperationProgress({ message: 'Checking for updates', progress: null });

      const releasesResult = await releasesClient.listOfficialReleases({ githubRepo, forceRefresh: false });
      const releases = Array.isArray(releasesResult?.releases) ? releasesResult.releases : [];
      const latest = releases.length ? releases[0].tag : '';
      if (!latest) {
        const err = new Error('No official releases available');
        err.code = 'NO_RELEASES';
        throw err;
      }

      _currentOperation = { ..._currentOperation, targetTag: latest };
      events.emit('progress', { ..._currentOperation });

      // Verify installability before any destructive step.
      updateOperationProgress({ message: 'Verifying availability', progress: null });
      const digestInfo = await docker.getRemoteDigest(imageRepo, latest);
      if (!digestInfo?.exists) {
        const err = new Error('Not yet available');
        err.code = 'NOT_YET_AVAILABLE';
        throw err;
      }

      // Pull image first (fail-safe ordering).
      const controller = new AbortController();
      _abortControllers.set(opId, controller);
      updateOperationProgress({ message: 'Downloading', progress: null, downloadProgress: 0, extractProgress: 0, canCancel: true });
      const pullResult = await docker.pullImage(imageRefForTag(imageRepo, latest), {
        signal: controller.signal,
        onProgress: (evt) => {
          const dl =
            typeof evt?.downloadProgress === 'number' && Number.isFinite(evt.downloadProgress) ? evt.downloadProgress : null;
          const ex =
            typeof evt?.extractProgress === 'number' && Number.isFinite(evt.extractProgress) ? evt.extractProgress : null;

          const message =
            typeof dl === 'number' && dl < 100 ? 'Downloading' : typeof ex === 'number' && ex < 100 ? 'Extracting' : 'Downloading';

          updateOperationProgress({ progress: dl, downloadProgress: dl, extractProgress: ex, message, canCancel: true });
        }
      });
      _abortControllers.delete(opId);

      if (pullResult?.status === 'aborted_client') {
        finishOperation('canceled', 'Canceled');
        return;
      }

      updateOperationProgress({ message: 'Switching versions', progress: null, canCancel: false });

      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;
      let activePortMappings = null;
      if (active && active.containerId) {
        try {
          const activeInspect = await docker.inspectContainer(active.containerId);
          activePortMappings = replacementPortMappingsFromInspect(activeInspect);
        } catch {
          activePortMappings = null;
        }
      }

      if (active && active.containerId) {
        // Stop and retain current active.
        updateOperationProgress({ message: 'Stopping current version', progress: null });
        const state = (active.state || '').toLowerCase();
        if (!state || state === 'running') {
          try {
            await docker.stopContainer(active.containerId, { t: 10 });
          } catch (e) {
            const m = typeof e?.message === 'string' ? e.message : '';
            if (!m || !/is not running/i.test(m)) throw e;
          }
        }

        const retainedAt = nowIso();
        const retainedName = retention.makeRetainedContainerName(imageRepo, active.tag || 'unknown', retainedAt);
        await docker.renameContainer(active.containerId, retainedName);
        retainedFromActive = { containerId: active.containerId, name: retainedName, retainedAt };
      }

      // Create and start new active.
      updateOperationProgress({ message: 'Starting new version', progress: null });
      createdNew = await createAndStartActiveContainer(
        docker,
        imageRepo,
        latest,
        portPreferences,
        {
          instanceName: active?.instanceName || undefined,
          portMappings: Array.isArray(activePortMappings) && activePortMappings.length ? activePortMappings : undefined
        },
        await stateStore.readStoragePreferences()
      );

      updateOperationProgress({ message: 'Starting new version (waiting for UI)', progress: null });
      if (createdNew && createdNew.containerId) {
        const waitRes = await waitForUiReachable(docker, createdNew.containerId, {
          timeoutMs: UI_READY_TIMEOUT_MS,
          intervalMs: 450,
          attemptTimeoutMs: UI_READY_ATTEMPT_TIMEOUT_MS,
          onTick: (seconds) => {
            const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
            updateOperationProgress({ message: `Starting new version (waiting for UI${s})`, progress: null });
          }
        });
        if (!waitRes.ok) {
          const err = new Error('Agent Zero UI is not reachable yet after switching versions.');
          err.code = 'UI_NOT_READY';
          throw err;
        }
      }

      // Enforce retention after success.
      if (keep > 0) {
        await enforceRetention(docker, imageRepo, policy);
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Completed' });
    } catch (error) {
      logDockerManagerError('updateToLatest', error, { opId });
      // Best-effort rollback if a previous active was retained and new start failed.
      try {
        if (createdNew && createdNew.containerId) {
          await docker.deleteContainer(createdNew.containerId, { force: true });
        }
      } catch {
        // ignore
      }

      try {
        if (retainedFromActive && retainedFromActive.containerId) {
          const activeName = retention.getActiveContainerName(imageRepo);
          await docker.renameContainer(retainedFromActive.containerId, activeName);
          await docker.startContainer(retainedFromActive.containerId);
        }
      } catch {
        // ignore
      }

      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'NOT_YET_AVAILABLE'
          ? 'The newest version is not available yet. Please try again later.'
          : '') ||
        'Update failed';
      finishOperation('failed', message);
    } finally {
      _abortControllers.delete(opId);
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('updateToLatest.unhandled', error, { opId });
  });

  return { opId, ack };
}

async function activateRetainedInstance(containerId, dataLossAck) {
  const imageRepo = getBackendImageRepo();
  const ack = assertDataLossAck(dataLossAck);
  const id = assertContainerId(containerId);

  requireNoRunningOperation();
  const opId = beginOperation('rollback', null);

  (async () => {
    /** @type {any} */
    let docker = null;
    let policy = null;
    let retainedFromActive = null;
    let target = null;

    try {
      docker = await getManagedDocker(imageRepo);
      policy = await stateStore.readRetentionPolicy();

      updateOperationProgress({ message: 'Preparing rollback', progress: null });

      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;
      target = (containers || []).find((c) => c && c.containerId === id) || null;

      if (!target || !retention.parseRetainedContainerName(target.containerName || '')) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      _currentOperation = { ..._currentOperation, targetTag: target.tag || null };
      events.emit('progress', { ..._currentOperation });

      if (active && active.containerId) {
        updateOperationProgress({ message: 'Stopping current version', progress: null });
        const state = (active.state || '').toLowerCase();
        if (!state || state === 'running') {
          try {
            await docker.stopContainer(active.containerId, { t: 10 });
          } catch (e) {
            const m = typeof e?.message === 'string' ? e.message : '';
            if (!m || !/is not running/i.test(m)) throw e;
          }
        }

        const retainedAt = nowIso();
        const retainedName = retention.makeRetainedContainerName(imageRepo, active.tag || 'unknown', retainedAt);
        await docker.renameContainer(active.containerId, retainedName);
        retainedFromActive = { containerId: active.containerId };
      }

      updateOperationProgress({ message: 'Starting selected version', progress: null });
      await docker.renameContainer(id, activeName);
      await docker.startContainer(id);

      updateOperationProgress({ message: 'Starting selected version (waiting for UI)', progress: null });
      const waitRes = await waitForUiReachable(docker, id, {
        timeoutMs: UI_READY_TIMEOUT_MS,
        intervalMs: 450,
        attemptTimeoutMs: UI_READY_ATTEMPT_TIMEOUT_MS,
        onTick: (seconds) => {
          const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
          updateOperationProgress({ message: `Starting selected version (waiting for UI${s})`, progress: null });
        }
      });
      if (!waitRes.ok) {
        const err = new Error('Agent Zero UI is not reachable yet after starting this version.');
        err.code = 'UI_NOT_READY';
        throw err;
      }

      await enforceRetention(docker, imageRepo, policy);

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Completed' });
    } catch (error) {
      logDockerManagerError('activateRetainedInstance', error, { opId, containerId: id });
      // Best-effort revert: if we stopped/retained active, try to restore it.
      try {
        if (retainedFromActive && retainedFromActive.containerId) {
          const activeName = retention.getActiveContainerName(imageRepo);
          await docker.renameContainer(retainedFromActive.containerId, activeName);
          await docker.startContainer(retainedFromActive.containerId);
        }
      } catch {
        // ignore
      }

      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'INSTANCE_NOT_FOUND' ? 'Instance not found.' : '') ||
        'Rollback failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('activateRetainedInstance.unhandled', error, { opId, containerId: id });
  });

  return { opId, ack };
}

async function activateTag(tag, dataLossAck, options = {}) {
  const imageRepo = getBackendImageRepo();
  const t = assertTagAllowedForActivate(tag);
  const ack = dataLossAck ? assertDataLossAck(dataLossAck) : 'proceed_without_backup';
  const activationOptions = normalizeActivationOptions(options, t);
  const shouldRememberCredentials =
    activationOptions.credentials?.remember &&
    !!activationOptions.credentials?.username &&
    !!activationOptions.credentials?.password;

  requireNoRunningOperation();
  const opId = beginOperation('activate', t);

  (async () => {
    /** @type {any} */
    let docker = null;
    let createdNew = null;

    try {
      docker = await getManagedDocker(imageRepo);

      updateOperationProgress({ message: 'Preparing instance', progress: null });
      if (shouldRememberCredentials) {
        stateStore.assertLocalInstanceCredentialStorageAvailable();
      }

      const localImages = await docker.listLocalImages(imageRepo);
      const hasTag = (localImages || []).some((img) => img && typeof img.tag === 'string' && img.tag === t);
      if (!hasTag) {
        const err = new Error('Version is not installed');
        err.code = 'NOT_INSTALLED';
        throw err;
      }

      updateOperationProgress({ message: 'Starting instance', progress: null });
      createdNew = await createAndStartManagedInstanceContainer(
        docker,
        imageRepo,
        t,
        activationOptions,
        await stateStore.readStoragePreferences()
      );
      if (shouldRememberCredentials && createdNew?.containerId) {
        await stateStore.writeLocalInstanceCredentials(createdNew.containerId, activationOptions.credentials);
      }

      updateOperationProgress({ message: 'Starting instance (waiting for UI)', progress: null });
      if (createdNew && createdNew.containerId) {
        const waitRes = await waitForUiReachable(docker, createdNew.containerId, {
          timeoutMs: UI_READY_TIMEOUT_MS,
          intervalMs: 450,
          attemptTimeoutMs: UI_READY_ATTEMPT_TIMEOUT_MS,
          onTick: (seconds) => {
            const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
            updateOperationProgress({ message: `Starting instance (waiting for UI${s})`, progress: null });
          }
        });
        if (!waitRes.ok) {
          const err = new Error('Agent Zero UI is not reachable yet after starting the instance.');
          err.code = 'UI_NOT_READY';
          throw err;
        }
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Completed', uiReady: true });
    } catch (error) {
      logDockerManagerError('activateTag', error, { opId, tag: t });
      if (shouldKeepCreatedManagedInstanceOnError(error, createdNew)) {
        finishOperation('completed', null);
        updateOperationProgress({
          progress: 100,
          message: 'Instance created. Agent Zero is still starting.',
          uiReady: false
        });
        return;
      }

      try {
        if (createdNew && createdNew.containerId) {
          await docker.deleteContainer(createdNew.containerId, { force: true });
        }
      } catch {
        // ignore
      }

      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'NOT_INSTALLED'
          ? 'This version is not installed yet.'
          : '') ||
        (error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '') ||
        'Run failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('activateTag.unhandled', error, { opId, tag: t });
  });

  return { opId, ack };
}

async function runCustomImage(options = {}) {
  const imageRepo = getBackendImageRepo();
  const custom = normalizeCustomImageOptions(options);

  requireNoRunningOperation();
  const opId = beginOperation('developer_run', custom.imageRef);

  (async () => {
    /** @type {any} */
    let docker = null;
    try {
      docker = await getManagedDocker(imageRepo);

      if (custom.pull) {
        const controller = new AbortController();
        _abortControllers.set(opId, controller);
        updateOperationProgress({
          message: 'Downloading custom image',
          progress: null,
          downloadProgress: 0,
          extractProgress: 0,
          canCancel: true
        });
        const pullResult = await docker.pullImage(custom.imageRef, {
          signal: controller.signal,
          onProgress: (evt) => {
            const dl =
              typeof evt?.downloadProgress === 'number' && Number.isFinite(evt.downloadProgress) ? evt.downloadProgress : null;
            const ex =
              typeof evt?.extractProgress === 'number' && Number.isFinite(evt.extractProgress) ? evt.extractProgress : null;
            const message =
              typeof dl === 'number' && dl < 100 ? 'Downloading custom image' : typeof ex === 'number' && ex < 100 ? 'Extracting custom image' : 'Downloading custom image';
            updateOperationProgress({ progress: dl, downloadProgress: dl, extractProgress: ex, message, canCancel: true });
          }
        });
        _abortControllers.delete(opId);
        if (pullResult?.status === 'aborted_client') {
          finishOperation('canceled', 'Canceled');
          return;
        }
      }

      updateOperationProgress({ message: 'Creating developer container', progress: null, canCancel: false });
      await createAndStartDeveloperContainer(docker, custom, await stateStore.readStoragePreferences());
      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Started' });
    } catch (error) {
      logDockerManagerError('runCustomImage', error, { opId, imageRef: custom.imageRef });
      const message = mapDockerInterfaceErrorToUiMessage(error) || error?.message || 'Custom image run failed';
      finishOperation('failed', message, error?.code || null);
    } finally {
      _abortControllers.delete(opId);
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('runCustomImage.unhandled', error, { opId, imageRef: custom.imageRef });
  });

  return { opId };
}

async function cancelOperation(opId) {
  const id = (opId || '').trim();
  if (!id) {
    const err = new Error('Invalid opId');
    err.code = 'INVALID_OP_ID';
    throw err;
  }

  if (!_currentOperation || _currentOperation.opId !== id) {
    const err = new Error('Operation not found');
    err.code = 'OP_NOT_FOUND';
    throw err;
  }

  if (_currentOperation.status !== 'running') {
    return { canceled: false };
  }

  const controller = _abortControllers.get(id);
  if (!controller) return { canceled: false };

  updateOperationProgress({
    message: 'Canceling',
    detail: 'Canceling download...',
    progress: null,
    indeterminate: true,
    canCancel: false
  });

  try {
    controller.abort();
  } catch {
    // ignore
  }

  return { canceled: true };
}

async function getDockerInventory() {
  const imageRepo = getBackendImageRepo();
  const [remoteInstances, localInstanceNames, localInstanceColors, localInstanceCredentials] = await Promise.all([
    stateStore.readRemoteInstances(),
    stateStore.readLocalInstanceNames(),
    stateStore.readLocalInstanceColors(),
    stateStore.readLocalInstanceCredentialsMetadata()
  ]);
  const docker = await getManagedDocker(imageRepo);
  const env = await docker.getEnvironment();
  let runtime = await assessRuntime(env);
  const runtimeDiagnostics = await collectRuntimeDiagnostics(docker, env);

  // Even when the ping-based env detection reports unavailable, attempt listing
  // so that Docker setups where ping fails but operations work are not blocked.
  let images = [];
  let containers = [];
  let volumes = [];
  let listingSucceeded = false;

  try {
    const results = await Promise.all([
      docker.listLocalImages(imageRepo),
      docker.listContainers(imageRepo),
      docker.listVolumes()
    ]);
    images = Array.isArray(results[0]) ? results[0] : [];
    containers = applyLocalInstanceIdentity(
      await enrichContainersWithWorkspaceStorage(
        docker,
        await enrichContainersWithRuntimeSource(docker, Array.isArray(results[1]) ? results[1] : [])
      ),
      localInstanceNames,
      localInstanceColors,
      localInstanceCredentials
    );
    volumes = Array.isArray(results[2]) ? results[2] : [];
    listingSucceeded = images.length > 0 || containers.length > 0 || volumes.length > 0;
  } catch {
    // Listing failed - Docker is genuinely unavailable.
  }

  const dockerAvailable = !!(env?.dockerAvailable || runtimeDiagnostics?.reachable || listingSucceeded);
  if (dockerAvailable && runtime?.state !== 'ready') {
    runtime = runtimeReadyAssessment(env);
  }

  return {
    dockerAvailable,
    environment: env || null,
    runtime,
    runtimeDiagnostics,
    images,
    containers,
    volumes,
    remoteInstances: enrichRemoteInstancesWithHealth(remoteInstances),
    backgroundOperations: backgroundOperationsSnapshot()
  };
}

async function getLocalInstanceLogs(containerId, options = {}) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const maxLines = clampContainerLogLines(options?.maxLines);
  const docker = await getManagedDocker(imageRepo);
  const containers = await docker.listContainers(imageRepo);
  const target = (containers || []).find((c) => c && c.containerId === id) || null;

  if (!target || !target.containerId) {
    const err = new Error('Instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  const result = await docker.readContainerLogs(id, {
    maxLines,
    timestamps: true,
    includeStderr: true
  });
  const lines = Array.isArray(result?.lines) ? result.lines.map(sanitizeContainerLogEvent) : [];

  return {
    containerId: id,
    containerName: target.containerName || '',
    instanceName: target.instanceName || target.containerName || id.slice(0, 12),
    fetchedAt: nowIso(),
    maxLines,
    aborted: !!result?.aborted,
    lines
  };
}

async function getLocalInstanceStorageFolder(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getManagedDocker(imageRepo);
  const containers = await docker.listContainers(imageRepo);
  const target = (containers || []).find((c) => c && c.containerId === id) || null;
  if (!target?.containerId) {
    const err = new Error('Instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  const inspect = await docker.inspectContainer(target.containerId);
  const folderPath = workspaceHostPathFromInspect(inspect);
  if (!folderPath) {
    const err = new Error('This instance does not expose a host storage folder.');
    err.code = 'WORKSPACE_FOLDER_UNAVAILABLE';
    throw err;
  }
  return {
    path: folderPath,
    mountTarget: WORKSPACE_MOUNT_TARGET
  };
}

async function removeVolume(volumeName) {
  const name = (volumeName || '').trim();
  if (!name) {
    const err = new Error('Invalid volumeName');
    err.code = 'INVALID_VOLUME_NAME';
    throw err;
  }
  const imageRepo = getBackendImageRepo();
  const docker = await getManagedDocker(imageRepo);
  await docker.removeVolume(name);
  return { removed: true };
}

async function pruneVolumes() {
  const imageRepo = getBackendImageRepo();
  const docker = await getManagedDocker(imageRepo);
  const result = await docker.pruneVolumes();
  return result && typeof result === 'object' ? result : {};
}

async function getContainerUiUrl(containerId, options = {}) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getManagedDocker(imageRepo);
  const waitRes = await waitForUiReachable(docker, id, {
    timeoutMs: Number.isFinite(Number(options?.timeoutMs)) ? Number(options.timeoutMs) : UI_READY_ATTEMPT_TIMEOUT_MS,
    intervalMs: Number.isFinite(Number(options?.intervalMs)) ? Number(options.intervalMs) : 450,
    attemptTimeoutMs: Number.isFinite(Number(options?.attemptTimeoutMs))
      ? Number(options.attemptTimeoutMs)
      : UI_READY_ATTEMPT_TIMEOUT_MS
  });
  return waitRes.ok ? waitRes.uiUrl : null;
}

module.exports = {
  // Config
  getBackendImageRepo,
  getBackendGithubRepo,
  imageRefForTag,

  // Tag allowlist helpers (used by IPC boundary)
  isSafeTag,
  isSemverReleaseTag,
  isLatestTag,
  isTestingTag,
  isCanonicalLocalTag,
  assertTagAllowedForInstall,
  assertTagAllowedForActivate,

  // State + events
  getDockerManagerState,
  refreshDockerManager,
  getCurrentOperation,
  events,

  // Operations (implemented in later tasks)
  installOrSync,
  removeInstalledImage,
  startActiveInstance,
  startLocalInstance,
  cloneLocalInstance,
  migrateLocalInstanceStorage,
  backupLocalInstance,
  restoreLocalInstance,
  renameLocalInstance,
  setLocalInstanceColor,
  setLocalInstanceCredentials,
  clearLocalInstanceCredentials,
  getLocalInstanceCredentials,
  stopActiveInstance,
  stopLocalInstance,
  setRetentionPolicy,
  setPortPreferences,
  setStoragePreferences,
  setInstanceDefaults,
  selectRuntimeEndpoint,
  provisionRuntime,
  resumeRuntimeSetupIfPending,
  addRemoteInstance,
  deleteRemoteInstance,
  renameRemoteInstance,
  setRemoteInstanceColor,
  deleteLocalInstance,
  getRemoteInstance,
  deleteRetainedInstance,
  updateToLatest,
  activateRetainedInstance,
  activateTag,
  runCustomImage,
  cancelOperation,
  getDockerInventory,
  getLocalInstanceLogs,
  getLocalInstanceStorageFolder,
  removeVolume,
  pruneVolumes,
  getContainerUiUrl,

  _test: {
    WORKSPACE_MOUNT_TARGET,
    normalizeStorageOverride,
    resolveWorkspaceStorage,
    applyWorkspaceStorage,
    windowsPathToWslMountSource,
    dockerMountSourceForHostPath,
    workspaceStorageFromInspect,
    workspaceHostPathFromInspect,
    waitForUiReachable,
    remoteHealthUrl,
    requestRemoteHealth,
    parsePortMappings,
    settlePortMappings,
    replacementPortMappingsFromInspect,
    shouldKeepCreatedManagedInstanceOnError,
    buildCloneCreateOptions,
    normalizeCloneWorkspaceSelection,
    selectedCloneWorkspaceCategoryIds,
    cloneWorkspaceSelectionIsAll,
    filterEnvTextForClone,
    filterSettingsJsonForClone,
    copySelectedWorkspaceData,
    workspaceTarEntryFromBackupEntry,
    buildAgentZeroBackupMetadata,
    createAgentZeroBackupZip,
    restoreAgentZeroBackupZip,
    releaseTagLabel,
    matchedSemverReleaseTagForDigest,
    matchedReleaseTagForLocalTag,
    imageTagForContainer,
    applyContainerMatchedReleaseTags
  },

  // Error helpers for IPC handlers
  toErrorResponse
};
