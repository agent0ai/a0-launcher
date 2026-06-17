import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DOCKER_HUB_AUTH_KEYS = [
  'https://index.docker.io/v1/',
  'https://index.docker.io/v1',
  'https://registry-1.docker.io',
  'https://registry-1.docker.io/',
  'registry-1.docker.io',
  'index.docker.io',
  'docker.io'
];

const CREDENTIAL_HELPER_TIMEOUT_MS = 2500;

function safeTrim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripScheme(value) {
  const text = safeTrim(value);
  return text.replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
}

function normalizeRegistry(value) {
  const host = stripScheme(value).split('/')[0].toLowerCase();
  if (!host || host === 'docker.io' || host === 'index.docker.io' || host === 'registry-1.docker.io') return 'docker.io';
  return host;
}

export function registryFromImageRef(imageRef) {
  const ref = safeTrim(imageRef);
  if (!ref) return 'docker.io';

  const first = ref.split('/')[0] || '';
  if (first.includes('.') || first.includes(':') || first === 'localhost') return normalizeRegistry(first);
  return 'docker.io';
}

export function authKeysForRegistry(registry) {
  const normalized = normalizeRegistry(registry);
  if (normalized === 'docker.io') return [...DOCKER_HUB_AUTH_KEYS];
  return [normalized, `https://${normalized}`, `http://${normalized}`];
}

function getAuthEntry(configJson, authKeys) {
  const auths = configJson?.auths;
  if (!auths || typeof auths !== 'object') return null;

  for (const key of authKeys) {
    const entry = auths[key];
    if (entry && typeof entry === 'object') return { key, entry };
  }

  const normalizedKeys = new Map();
  for (const key of Object.keys(auths)) {
    normalizedKeys.set(stripScheme(key).toLowerCase(), key);
  }

  for (const key of authKeys) {
    const match = normalizedKeys.get(stripScheme(key).toLowerCase());
    const entry = match ? auths[match] : null;
    if (entry && typeof entry === 'object') return { key: match, entry };
  }

  return null;
}

function decodeInlineAuth(auth) {
  const text = safeTrim(auth);
  if (!text) return null;

  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep <= 0) return null;
    return {
      username: decoded.slice(0, sep),
      password: decoded.slice(sep + 1)
    };
  } catch {
    return null;
  }
}

export function dockerAuthConfigFromEntry(entry, serveraddress) {
  if (!entry || typeof entry !== 'object') return null;
  const server = safeTrim(serveraddress);
  if (!server) return null;

  const identitytoken = safeTrim(entry.identitytoken);
  if (identitytoken) return { identitytoken, serveraddress: server };

  const username = safeTrim(entry.username);
  const password = typeof entry.password === 'string' ? entry.password : '';
  if (username && password) return { username, password, serveraddress: server };

  const decoded = decodeInlineAuth(entry.auth);
  if (decoded?.username && decoded.password) {
    return { ...decoded, serveraddress: server };
  }

  return null;
}

function credentialHelperForKey(configJson, authKey, registry) {
  const normalizedKey = stripScheme(authKey).toLowerCase();
  const normalizedRegistry = normalizeRegistry(registry);
  const helpers = configJson?.credHelpers;

  if (helpers && typeof helpers === 'object') {
    const candidates = [
      authKey,
      authKey.replace(/\/+$/g, ''),
      normalizedKey,
      normalizedRegistry
    ];
    for (const key of candidates) {
      const helper = safeTrim(helpers[key]);
      if (helper) return helper;
    }
  }

  return safeTrim(configJson?.credsStore);
}

function isSafeCredentialHelperName(helperName) {
  return /^[A-Za-z0-9_.-]+$/.test(safeTrim(helperName));
}

function authConfigFromHelperResult(result, serveraddress) {
  if (!result || typeof result !== 'object') return null;
  const server = safeTrim(serveraddress || result.ServerURL);
  const username = safeTrim(result.Username);
  const secret = typeof result.Secret === 'string' ? result.Secret : '';

  if (!server || !secret) return null;
  if (username === '<token>') return { identitytoken: secret, serveraddress: server };
  if (username) return { username, password: secret, serveraddress: server };
  return null;
}

async function defaultRunCredentialHelper(helperName, serveraddress, options = {}) {
  const helper = safeTrim(helperName);
  const server = safeTrim(serveraddress);
  if (!helper || !server || !isSafeCredentialHelperName(helper)) return null;

  const command = `docker-credential-${helper}`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(250, Number(options.timeoutMs))
    : CREDENTIAL_HELPER_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(command, ['get'], {
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.on('error', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) child.kill();
    });

    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      try {
        finish(JSON.parse(stdout));
      } catch {
        finish(null);
      }
    });

    try {
      child.stdin.end(server);
    } catch {
      finish(null);
    }
  });
}

export async function readDockerConfigJson(options = {}) {
  const env = options.env || process.env;
  const homeDir = safeTrim(options.homeDir) || os.homedir();
  const dockerConfigDir = safeTrim(env.DOCKER_CONFIG) || path.join(homeDir, '.docker');
  const configPath = path.join(dockerConfigDir, 'config.json');

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveDockerAuthConfigForRegistry(registry, options = {}) {
  const normalizedRegistry = normalizeRegistry(registry);
  const authKeys = Array.isArray(options.authKeys) ? options.authKeys : authKeysForRegistry(normalizedRegistry);
  const configJson = options.dockerConfig || await readDockerConfigJson(options);
  if (!configJson) return null;

  const authMatch = getAuthEntry(configJson, authKeys);
  if (authMatch) {
    const inlineAuth = dockerAuthConfigFromEntry(authMatch.entry, authMatch.key);
    if (inlineAuth) return inlineAuth;
  }

  const helperRunner = typeof options.runCredentialHelper === 'function'
    ? options.runCredentialHelper
    : defaultRunCredentialHelper;

  for (const authKey of authKeys) {
    const helperName = credentialHelperForKey(configJson, authKey, normalizedRegistry);
    if (!helperName || !isSafeCredentialHelperName(helperName)) continue;

    const helperResult = await helperRunner(helperName, authKey, options);
    const helperAuth = authConfigFromHelperResult(helperResult, authKey);
    if (helperAuth) return helperAuth;
  }

  return null;
}

export async function resolveDockerAuthConfigForImage(imageRef, options = {}) {
  return resolveDockerAuthConfigForRegistry(registryFromImageRef(imageRef), options);
}

export function dockerBasicHeaderFromAuthConfig(authConfig) {
  if (!authConfig || typeof authConfig !== 'object') return null;

  const username = safeTrim(authConfig.username);
  const password = typeof authConfig.password === 'string' ? authConfig.password : '';
  if (username && password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  const decoded = decodeInlineAuth(authConfig.auth);
  if (decoded?.username && decoded.password) {
    return `Basic ${Buffer.from(`${decoded.username}:${decoded.password}`).toString('base64')}`;
  }

  return null;
}
