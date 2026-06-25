import Dockerode from 'dockerode';
import { once } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DockerInterface } from '../DockerInterface.mjs';
import { resolveDockerAuthConfigForImage } from './DockerAuthConfig.mjs';
import { DockerHubRegistry } from './DockerHubRegistry.mjs';
import {
  followContainerLogs as dockerodeFollowContainerLogs,
  readContainerLogs as dockerodeReadContainerLogs
} from './DockerodeLogProcessor.mjs';

function makeOpId() {
  const rand = Math.random().toString(16).slice(2, 8);
  return `pull_${Date.now()}_${rand}`;
}

function imageRepoFromRef(imageRef) {
  const ref = (imageRef || '').trim();
  if (!ref) return '';
  const at = ref.indexOf('@');
  const colon = ref.lastIndexOf(':');
  if (at !== -1) return ref.slice(0, at);
  if (colon !== -1 && colon > ref.indexOf('/')) return ref.slice(0, colon);
  return ref;
}

function tagFromRef(imageRef) {
  const ref = (imageRef || '').trim();
  if (!ref) return '';
  const at = ref.indexOf('@');
  const colon = ref.lastIndexOf(':');
  if (at !== -1) return '';
  if (colon !== -1 && colon > ref.indexOf('/')) return ref.slice(colon + 1);
  return '';
}

function splitTaggedImageRef(imageRef) {
  const ref = (imageRef || '').trim();
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (!ref || lastColon <= lastSlash || lastColon === ref.length - 1) {
    throw makeDockerInterfaceError('INVALID_IMAGE', 'imageRef must include a repository and tag');
  }
  return {
    repo: ref.slice(0, lastColon),
    tag: ref.slice(lastColon + 1)
  };
}

function bestUiPortFromList(ports) {
  const candidates = [];
  for (const port of Array.isArray(ports) ? ports : []) {
    const privatePort = Number(port?.PrivatePort);
    const publicPort = Number(port?.PublicPort);
    if (!Number.isFinite(privatePort) || privatePort <= 0 || privatePort > 65535) continue;
    if (!Number.isFinite(publicPort) || publicPort <= 0 || publicPort > 65535) continue;
    candidates.push({ privatePort, publicPort });
  }

  if (!candidates.length) return null;
  const preferredPrivatePorts = [80, 7860, 3000, 8080, 5000, 9000, 9001, 9002];
  for (const p of preferredPrivatePorts) {
    const match = candidates.find((candidate) => candidate.privatePort === p);
    if (match) return match;
  }

  candidates.sort((a, b) => a.publicPort - b.publicPort);
  return candidates.find((candidate) => candidate.privatePort !== 22) || candidates[0];
}

function safeIsoNow() {
  return new Date().toISOString();
}

function makeDockerInterfaceError(code, message, details = {}, cause = null) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.name = 'DockerInterfaceError';
  err.code = code;
  err.details = details;
  return err;
}

function normalizeDockerError(error, context = {}) {
  if (error?.name === 'DockerInterfaceError') return error;

  const code = error?.code || '';
  const statusCode = error?.statusCode;
  const message = typeof error?.message === 'string' ? error.message : '';

  const details = {
    ...context,
    code,
    errno: error?.errno,
    syscall: error?.syscall,
    address: error?.address,
    port: error?.port,
    statusCode
  };

  if (typeof statusCode === 'number' && statusCode === 429) {
    return makeDockerInterfaceError('DOCKER_PULL_RATE_LIMIT', 'Docker Hub pull rate limit exceeded', details, error);
  }
  if (message && /(?:pull\s+)?rate limit|too many requests/i.test(message)) {
    return makeDockerInterfaceError('DOCKER_PULL_RATE_LIMIT', 'Docker Hub pull rate limit exceeded', details, error);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return makeDockerInterfaceError('PERMISSION_DENIED', 'Permission denied accessing Docker', details, error);
  }
  if (code === 'ENOENT') {
    return makeDockerInterfaceError('DOCKER_NOT_FOUND', 'Docker is not installed or not available', details, error);
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
    return makeDockerInterfaceError('DAEMON_UNAVAILABLE', 'Docker daemon is not reachable', details, error);
  }
  if (typeof statusCode === 'number' && statusCode === 404) {
    return makeDockerInterfaceError('NOT_FOUND', 'Docker resource not found', details, error);
  }
  if (typeof statusCode === 'number' && statusCode === 409) {
    return makeDockerInterfaceError('CONFLICT', 'Docker operation conflict', details, error);
  }

  return makeDockerInterfaceError('DOCKER_ERROR', error?.message || 'Docker operation failed', details, error);
}

function validateContainerFilePath(value) {
  const filePath = String(value || '').trim();
  if (!filePath || !filePath.startsWith('/')) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'filePath must be an absolute container path');
  }
  if (filePath.length > 4096 || /[\0\r\n]/.test(filePath)) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'filePath is invalid');
  }
  return filePath;
}

function clampReadBytes(value) {
  const fallback = 64 * 1024;
  const max = Number(value);
  if (!Number.isFinite(max)) return fallback;
  return Math.max(1, Math.min(1024 * 1024, Math.floor(max)));
}

function clampArchiveListBytes(value) {
  const fallback = 8 * 1024 * 1024;
  const max = Number(value);
  if (!Number.isFinite(max)) return fallback;
  return Math.max(1, Math.min(64 * 1024 * 1024, Math.floor(max)));
}

function textOrNull(value, maxLength = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.slice(0, maxLength);
}

function finiteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stringList(value, limit = 12, maxLength = 180) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    const text = textOrNull(item, maxLength);
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanDockerResourceName(value, label) {
  const text = String(value || '').trim();
  if (!text) throw makeDockerInterfaceError('INVALID_INPUT', `${label} is required`);
  if (text.length > 255 || /[\0\r\n]/.test(text)) {
    throw makeDockerInterfaceError('INVALID_INPUT', `${label} is invalid`);
  }
  return text;
}

function normalizeProbeHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw makeDockerInterfaceError('INVALID_INPUT', 'url is required');
  if (text.length > 2048 || /[\0\r\n]/.test(text)) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'url is invalid');
  }

  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'url is invalid', {}, error);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw makeDockerInterfaceError('INVALID_INPUT', 'url must be HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'url must not include credentials');
  }
  return url.href;
}

function normalizeHttpRequestPath(value, label = 'path') {
  const text = String(value || '').trim();
  if (!text || !text.startsWith('/') || text.length > 512 || /[\0\r\n]/.test(text)) {
    throw makeDockerInterfaceError('INVALID_INPUT', `${label} is invalid`);
  }
  return text;
}

function normalizeHttpOrigin(value) {
  const text = String(value || 'http://localhost').trim();
  if (text.length > 512 || /[\0\r\n]/.test(text)) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'origin is invalid');
  }
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'origin is invalid', {}, error);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw makeDockerInterfaceError('INVALID_INPUT', 'origin must be HTTP or HTTPS');
  }
  return url.origin;
}

function clampHttpProbeTimeoutMs(value) {
  const fallback = 3500;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(500, Math.min(15000, Math.floor(number)));
}

function clampA2aMessageTimeoutMs(value) {
  const fallback = 30000;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(500, Math.min(60000, Math.floor(number)));
}

function redactTokenizedA2aUrl(value) {
  return String(value || '').replace(/\/a2a\/t-[^/?#\s]+/gu, '/a2a/t-...');
}

function normalizeJsonPayloadBase64(payload) {
  let text = '';
  try {
    text = JSON.stringify(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
  } catch (error) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'payload must be JSON serializable', {}, error);
  }
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'payload is too large');
  }
  return Buffer.from(text, 'utf8').toString('base64');
}

function normalizeTextPayloadBase64(value, label = 'message') {
  const text = String(value || '').trim();
  if (!text) throw makeDockerInterfaceError('INVALID_INPUT', `${label} is required`);
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw makeDockerInterfaceError('INVALID_INPUT', `${label} is too large`);
  }
  return Buffer.from(text, 'utf8').toString('base64');
}

function parseHttpProbeOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed || typeof parsed !== 'object') continue;
      return {
        reachable: parsed.reachable === true,
        statusCode: Number.isFinite(Number(parsed.statusCode)) ? Number(parsed.statusCode) : null,
        elapsedMs: Number.isFinite(Number(parsed.elapsedMs)) ? Math.max(0, Math.floor(Number(parsed.elapsedMs))) : null,
        error: textOrNull(parsed.error, 300) || ''
      };
    } catch {
      // Keep scanning for the bounded JSON payload.
    }
  }
  return null;
}

function parseJsonPostOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed || typeof parsed !== 'object') continue;
      return {
        ok: parsed.ok === true,
        statusCode: Number.isFinite(Number(parsed.statusCode)) ? Number(parsed.statusCode) : null,
        elapsedMs: Number.isFinite(Number(parsed.elapsedMs)) ? Math.max(0, Math.floor(Number(parsed.elapsedMs))) : null,
        responseText: textOrNull(parsed.responseText, 8192) || '',
        responseJson: parsed.responseJson && typeof parsed.responseJson === 'object' && !Array.isArray(parsed.responseJson)
          ? parsed.responseJson
          : null,
        error: textOrNull(parsed.error, 500) || ''
      };
    } catch {
      // Keep scanning for the bounded JSON payload.
    }
  }
  return null;
}

function parseA2aMessageOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed || typeof parsed !== 'object') continue;
      return {
        ok: parsed.ok === true,
        statusCode: Number.isFinite(Number(parsed.statusCode)) ? Number(parsed.statusCode) : null,
        elapsedMs: Number.isFinite(Number(parsed.elapsedMs)) ? Math.max(0, Math.floor(Number(parsed.elapsedMs))) : null,
        taskId: textOrNull(parsed.taskId, 180) || '',
        contextId: textOrNull(parsed.contextId, 180) || '',
        state: textOrNull(parsed.state, 80) || '',
        assistantText: textOrNull(parsed.assistantText, 8192) || '',
        responseText: textOrNull(parsed.responseText, 8192) || '',
        responseJson: parsed.responseJson && typeof parsed.responseJson === 'object' && !Array.isArray(parsed.responseJson)
          ? parsed.responseJson
          : null,
        error: textOrNull(parsed.error, 500) || '',
        pending: parsed.pending === true
      };
    } catch {
      // Keep scanning for the bounded JSON payload.
    }
  }
  return null;
}

function normalizeA2aTaskId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 180 || /[\0\r\n/]/.test(id)) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'taskId is required');
  }
  return id;
}

function demuxDockerExecBuffer(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  if (!source.length) return { stdoutText: '', stderrText: '' };

  const stdout = [];
  const stderr = [];
  let offset = 0;
  let framed = false;

  while (offset + 8 <= source.length) {
    const streamType = source[offset];
    const size = source.readUInt32BE(offset + 4);
    if ((streamType !== 1 && streamType !== 2) || size < 0 || offset + 8 + size > source.length) {
      framed = false;
      break;
    }
    framed = true;
    const payload = source.subarray(offset + 8, offset + 8 + size);
    if (streamType === 2) stderr.push(payload);
    else stdout.push(payload);
    offset += 8 + size;
  }

  if (framed && offset === source.length) {
    return {
      stdoutText: Buffer.concat(stdout).toString('utf8'),
      stderrText: Buffer.concat(stderr).toString('utf8')
    };
  }

  return {
    stdoutText: source.toString('utf8'),
    stderrText: ''
  };
}

const HTTP_PROBE_SCRIPT = `
url="$1"
timeout="$2"
if command -v python3 >/dev/null 2>&1; then
  pybin=python3
elif command -v python >/dev/null 2>&1; then
  pybin=python
else
  printf '%s\\n' '{"reachable":false,"statusCode":null,"elapsedMs":0,"error":"python_not_found"}'
  exit 3
fi
"$pybin" - "$url" "$timeout" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

url = sys.argv[1]
try:
    timeout = max(0.5, min(15.0, float(sys.argv[2]) / 1000.0))
except Exception:
    timeout = 3.5

start = time.time()
request = urllib.request.Request(
    url,
    headers={"User-Agent": "A0-Launcher-Topology-Probe/1.0"},
    method="HEAD",
)

def elapsed_ms():
    return int(max(0, (time.time() - start) * 1000))

try:
    response = urllib.request.urlopen(request, timeout=timeout)
    status = int(getattr(response, "status", response.getcode()))
    response.close()
    print(json.dumps({"reachable": True, "statusCode": status, "elapsedMs": elapsed_ms(), "error": ""}))
except urllib.error.HTTPError as exc:
    print(json.dumps({"reachable": True, "statusCode": int(exc.code), "elapsedMs": elapsed_ms(), "error": ""}))
except Exception as exc:
    print(json.dumps({
        "reachable": False,
        "statusCode": None,
        "elapsedMs": elapsed_ms(),
        "error": type(exc).__name__ + ": " + str(exc),
    }))
PY
`;

const HTTP_JSON_CSRF_POST_SCRIPT = `
base_url="$1"
post_path="$2"
payload_b64="$3"
csrf_path="$4"
origin="$5"
timeout="$6"
if command -v python3 >/dev/null 2>&1; then
  pybin=python3
elif command -v python >/dev/null 2>&1; then
  pybin=python
else
  printf '%s\\n' '{"ok":false,"statusCode":null,"elapsedMs":0,"responseText":"","responseJson":null,"error":"python_not_found"}'
  exit 3
fi
"$pybin" - "$base_url" "$post_path" "$payload_b64" "$csrf_path" "$origin" "$timeout" <<'PY'
import base64
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

base_url, post_path, payload_b64, csrf_path, origin, timeout_raw = sys.argv[1:7]
try:
    timeout = max(0.5, min(30.0, float(timeout_raw) / 1000.0))
except Exception:
    timeout = 8.0

start = time.time()

def elapsed_ms():
    return int(max(0, (time.time() - start) * 1000))

def emit(ok, status_code=None, response_text="", response_json=None, error=""):
    print(json.dumps({
        "ok": bool(ok),
        "statusCode": status_code,
        "elapsedMs": elapsed_ms(),
        "responseText": response_text[:8192] if isinstance(response_text, str) else "",
        "responseJson": response_json if isinstance(response_json, dict) else None,
        "error": str(error)[:500] if error else "",
    }))

def full_url(path):
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", str(path).lstrip("/"))

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

try:
    csrf_request = urllib.request.Request(
        full_url(csrf_path),
        headers={"Origin": origin, "Referer": origin.rstrip("/") + "/"},
    )
    csrf_response = opener.open(csrf_request, timeout=timeout)
    csrf_text = csrf_response.read(65536).decode("utf-8", errors="replace")
    csrf_data = json.loads(csrf_text)
    token = csrf_data.get("token") if csrf_data.get("ok") else None
    if not token:
        emit(False, getattr(csrf_response, "status", None), csrf_text, csrf_data if isinstance(csrf_data, dict) else None, csrf_data.get("error") or "csrf_token_missing")
        sys.exit(0)

    payload_bytes = base64.b64decode(payload_b64.encode("ascii"), validate=True)
    post_request = urllib.request.Request(
        full_url(post_path),
        data=payload_bytes,
        headers={
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "Origin": origin,
            "Referer": origin.rstrip("/") + "/",
        },
        method="POST",
    )
    post_response = opener.open(post_request, timeout=timeout)
    response_text = post_response.read(65536).decode("utf-8", errors="replace")
    response_json = None
    try:
        parsed = json.loads(response_text)
        if isinstance(parsed, dict):
            response_json = parsed
    except Exception:
        pass
    status = int(getattr(post_response, "status", post_response.getcode()))
    emit(200 <= status < 300, status, response_text, response_json, "")
except urllib.error.HTTPError as exc:
    body = exc.read(65536).decode("utf-8", errors="replace")
    parsed = None
    try:
        maybe = json.loads(body)
        if isinstance(maybe, dict):
            parsed = maybe
    except Exception:
        pass
    emit(False, int(exc.code), body, parsed, body or str(exc))
except Exception as exc:
    emit(False, None, "", None, type(exc).__name__ + ": " + str(exc))
PY
`;

const A2A_MESSAGE_SCRIPT = `
agent_url="$1"
message_b64="$2"
timeout="$3"
wait_ms="$4"
poll_ms="$5"
if command -v python3 >/dev/null 2>&1; then
  pybin=python3
elif command -v python >/dev/null 2>&1; then
  pybin=python
else
  printf '%s\\n' '{"ok":false,"statusCode":null,"elapsedMs":0,"taskId":"","contextId":"","state":"","assistantText":"","responseText":"","responseJson":null,"error":"python_not_found"}'
  exit 3
fi
"$pybin" - "$agent_url" "$message_b64" "$timeout" "$wait_ms" "$poll_ms" <<'PY'
import base64
import json
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

agent_url, message_b64, timeout_raw, wait_raw, poll_raw = sys.argv[1:6]
try:
    timeout = max(0.5, min(60.0, float(timeout_raw) / 1000.0))
except Exception:
    timeout = 30.0
try:
    wait_ms = max(0, min(180000, int(float(wait_raw))))
except Exception:
    wait_ms = 60000
try:
    poll_ms = max(250, min(10000, int(float(poll_raw))))
except Exception:
    poll_ms = 2000

start = time.time()

def elapsed_ms():
    return int(max(0, (time.time() - start) * 1000))

def emit(ok, status_code=None, task_id="", context_id="", state="", assistant_text="", response_text="", response_json=None, error="", pending=False):
    print(json.dumps({
        "ok": bool(ok),
        "statusCode": status_code,
        "elapsedMs": elapsed_ms(),
        "taskId": str(task_id or "")[:180],
        "contextId": str(context_id or "")[:180],
        "state": str(state or "")[:80],
        "assistantText": str(assistant_text or "")[:8192],
        "responseText": response_text[:8192] if isinstance(response_text, str) else "",
        "responseJson": response_json if isinstance(response_json, dict) else None,
        "error": str(error)[:500] if error else "",
        "pending": bool(pending),
    }))

def endpoint():
    return urllib.parse.urljoin(agent_url.rstrip("/") + "/", ".")

def latest_text_from_message(message):
    if isinstance(message, str):
        return message.strip()
    if not isinstance(message, dict):
        return ""
    parts = message.get("parts")
    if isinstance(parts, list):
        texts = []
        for part in parts:
            if isinstance(part, dict):
                value = part.get("text") or part.get("content")
                if isinstance(value, str) and value.strip():
                    texts.append(value.strip())
        if texts:
            return "\\n".join(texts)
    for key in ("text", "content", "message", "output"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def extract_assistant_text(data):
    if not isinstance(data, dict):
        return ""
    result = data.get("result", data)
    if not isinstance(result, dict):
        return ""
    history = result.get("history")
    if isinstance(history, list):
        for message in reversed(history):
            if isinstance(message, dict) and message.get("role") == "user":
                continue
            text = latest_text_from_message(message)
            if text:
                return text
    status = result.get("status")
    if isinstance(status, dict):
        text = latest_text_from_message(status.get("message"))
        if text:
            return text
    artifacts = result.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in reversed(artifacts):
            text = latest_text_from_message(artifact)
            if text:
                return text
    return latest_text_from_message(result)

def post_json(payload):
    raw = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint(),
        data=raw,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "A0-Launcher-A2A/1.0",
        },
        method="POST",
    )
    response = urllib.request.urlopen(request, timeout=timeout)
    response_text = response.read(1024 * 1024).decode("utf-8", errors="replace")
    status = int(getattr(response, "status", response.getcode()))
    parsed = json.loads(response_text)
    return status, response_text, parsed

try:
    message = base64.b64decode(message_b64.encode("ascii"), validate=True).decode("utf-8")
    request_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "parts": [{"kind": "text", "text": message}],
                "kind": "message",
                "messageId": message_id,
            },
            "configuration": {
                "acceptedOutputModes": ["application/json", "text/plain"],
                "blocking": False,
            },
        },
    }
    status, response_text, response_json = post_json(payload)
    result = response_json.get("result") if isinstance(response_json, dict) else None
    if not isinstance(result, dict):
        emit(False, status, response_text=response_text, response_json=response_json, error="A2A response missing result")
        sys.exit(0)
    task_id = result.get("id") or ""
    context_id = result.get("contextId") or result.get("context_id") or ""
    state = (result.get("status") or {}).get("state") if isinstance(result.get("status"), dict) else ""
    assistant_text = extract_assistant_text(response_json)
    if state in ("completed", "failed", "canceled") or not task_id or wait_ms <= 0:
        pending = bool(task_id) and state not in ("completed", "failed", "canceled")
        emit(state == "completed" or (200 <= status < 300 and bool(task_id)), status, task_id, context_id, state or "submitted", assistant_text, response_text, response_json, "" if 200 <= status < 300 else f"HTTP {status}", pending)
        sys.exit(0)

    deadline = time.time() + (wait_ms / 1000.0)
    last_status = status
    last_text = response_text
    last_json = response_json
    while time.time() < deadline:
        time.sleep(poll_ms / 1000.0)
        task_payload = {
            "jsonrpc": "2.0",
            "id": None,
            "method": "tasks/get",
            "params": {"id": task_id},
        }
        try:
            last_status, last_text, last_json = post_json(task_payload)
        except Exception as exc:
            continue
        result = last_json.get("result") if isinstance(last_json, dict) else None
        if not isinstance(result, dict):
            continue
        context_id = result.get("contextId") or result.get("context_id") or context_id
        state = (result.get("status") or {}).get("state") if isinstance(result.get("status"), dict) else state
        assistant_text = extract_assistant_text(last_json)
        if state in ("completed", "failed", "canceled"):
            emit(state == "completed", last_status, task_id, context_id, state, assistant_text, last_text, last_json, "" if state == "completed" else f"A2A task {state}")
            sys.exit(0)
    emit(True, last_status, task_id, context_id, state or "submitted", assistant_text, last_text, last_json, "", True)
except urllib.error.HTTPError as exc:
    body = exc.read(65536).decode("utf-8", errors="replace")
    parsed = None
    try:
        maybe = json.loads(body)
        if isinstance(maybe, dict):
            parsed = maybe
    except Exception:
        pass
    emit(False, int(exc.code), response_text=body, response_json=parsed, error=body or str(exc))
except Exception as exc:
    emit(False, None, error=type(exc).__name__ + ": " + str(exc))
PY
`;

const A2A_TASK_POLL_SCRIPT = `
agent_url="$1"
task_id="$2"
timeout="$3"
wait_ms="$4"
poll_ms="$5"
if command -v python3 >/dev/null 2>&1; then
  pybin=python3
elif command -v python >/dev/null 2>&1; then
  pybin=python
else
  printf '%s\\n' '{"ok":false,"statusCode":null,"elapsedMs":0,"taskId":"","contextId":"","state":"","assistantText":"","responseText":"","responseJson":null,"error":"python_not_found","pending":false}'
  exit 3
fi
"$pybin" - "$agent_url" "$task_id" "$timeout" "$wait_ms" "$poll_ms" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

agent_url, task_id, timeout_raw, wait_raw, poll_raw = sys.argv[1:6]
try:
    timeout = max(0.5, min(60.0, float(timeout_raw) / 1000.0))
except Exception:
    timeout = 30.0
try:
    wait_ms = max(0, min(300000, int(float(wait_raw))))
except Exception:
    wait_ms = 60000
try:
    poll_ms = max(250, min(10000, int(float(poll_raw))))
except Exception:
    poll_ms = 2000

start = time.time()

def elapsed_ms():
    return int(max(0, (time.time() - start) * 1000))

def emit(ok, status_code=None, context_id="", state="", assistant_text="", response_text="", response_json=None, error="", pending=False):
    print(json.dumps({
        "ok": bool(ok),
        "statusCode": status_code,
        "elapsedMs": elapsed_ms(),
        "taskId": str(task_id or "")[:180],
        "contextId": str(context_id or "")[:180],
        "state": str(state or "")[:80],
        "assistantText": str(assistant_text or "")[:8192],
        "responseText": response_text[:8192] if isinstance(response_text, str) else "",
        "responseJson": response_json if isinstance(response_json, dict) else None,
        "error": str(error)[:500] if error else "",
        "pending": bool(pending),
    }))

def endpoint():
    return urllib.parse.urljoin(agent_url.rstrip("/") + "/", ".")

def latest_text_from_message(message):
    if isinstance(message, str):
        return message.strip()
    if not isinstance(message, dict):
        return ""
    parts = message.get("parts")
    if isinstance(parts, list):
        texts = []
        for part in parts:
            if isinstance(part, dict):
                value = part.get("text") or part.get("content")
                if isinstance(value, str) and value.strip():
                    texts.append(value.strip())
        if texts:
            return "\\n".join(texts)
    for key in ("text", "content", "message", "output"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def extract_assistant_text(data):
    if not isinstance(data, dict):
        return ""
    result = data.get("result", data)
    if not isinstance(result, dict):
        return ""
    history = result.get("history")
    if isinstance(history, list):
        for message in reversed(history):
            if isinstance(message, dict) and message.get("role") == "user":
                continue
            text = latest_text_from_message(message)
            if text:
                return text
    status = result.get("status")
    if isinstance(status, dict):
        text = latest_text_from_message(status.get("message"))
        if text:
            return text
    artifacts = result.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in reversed(artifacts):
            text = latest_text_from_message(artifact)
            if text:
                return text
    return latest_text_from_message(result)

def post_task_get():
    raw = json.dumps({
        "jsonrpc": "2.0",
        "id": None,
        "method": "tasks/get",
        "params": {"id": task_id},
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint(),
        data=raw,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "A0-Launcher-A2A/1.0",
        },
        method="POST",
    )
    response = urllib.request.urlopen(request, timeout=timeout)
    response_text = response.read(1024 * 1024).decode("utf-8", errors="replace")
    status = int(getattr(response, "status", response.getcode()))
    parsed = json.loads(response_text)
    return status, response_text, parsed

deadline = time.time() + (wait_ms / 1000.0)
last_status = None
last_text = ""
last_json = None
context_id = ""
state = "submitted"
assistant_text = ""

while True:
    try:
        last_status, last_text, last_json = post_task_get()
    except urllib.error.HTTPError as exc:
        body = exc.read(65536).decode("utf-8", errors="replace")
        parsed = None
        try:
            maybe = json.loads(body)
            if isinstance(maybe, dict):
                parsed = maybe
        except Exception:
            pass
        emit(False, int(exc.code), response_text=body, response_json=parsed, error=body or str(exc))
        break
    except Exception:
        if time.time() >= deadline:
            emit(True, last_status, context_id, state, assistant_text, last_text, last_json, "", True)
            break
        time.sleep(poll_ms / 1000.0)
        continue

    result = last_json.get("result") if isinstance(last_json, dict) else None
    if isinstance(result, dict):
        context_id = result.get("contextId") or result.get("context_id") or context_id
        state = (result.get("status") or {}).get("state") if isinstance(result.get("status"), dict) else state
        assistant_text = extract_assistant_text(last_json)
        if state in ("completed", "failed", "canceled"):
            emit(state == "completed", last_status, context_id, state, assistant_text, last_text, last_json, "" if state == "completed" else f"A2A task {state}")
            break

    if time.time() >= deadline:
        emit(True, last_status, context_id, state or "submitted", assistant_text, last_text, last_json, "", True)
        break
    time.sleep(poll_ms / 1000.0)
PY
`;

function normalizedLabelMap(value) {
  const out = {};
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const [keyRaw, valueRaw] of Object.entries(source)) {
    const key = String(keyRaw || '').trim();
    const val = String(valueRaw || '').trim();
    if (!key || /[\0\r\n]/.test(key)) continue;
    out[key] = val;
  }
  return out;
}

function normalizedNetworkAliases(value) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    const alias = String(item || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 120);
    if (alias && !out.includes(alias)) out.push(alias);
    if (out.length >= 8) break;
  }
  return out;
}

function formatNetworkInspect(value) {
  const labels = normalizedLabelMap(value?.Labels);
  const containers = {};
  const rawContainers = value?.Containers && typeof value.Containers === 'object' ? value.Containers : {};
  for (const [id, entry] of Object.entries(rawContainers)) {
    const containerId = String(id || '').trim();
    if (!containerId) continue;
    containers[containerId] = {
      name: textOrNull(entry?.Name, 180) || '',
      endpointId: textOrNull(entry?.EndpointID, 180) || '',
      ipv4Address: textOrNull(entry?.IPv4Address, 80) || '',
      ipv6Address: textOrNull(entry?.IPv6Address, 120) || '',
      aliases: stringList(entry?.Aliases, 16, 120)
    };
  }
  return {
    id: textOrNull(value?.Id, 180) || '',
    name: textOrNull(value?.Name, 255) || '',
    driver: textOrNull(value?.Driver, 80) || '',
    scope: textOrNull(value?.Scope, 80) || '',
    labels,
    containers
  };
}

function findNetworkContainer(network, containerId) {
  const id = String(containerId || '').trim();
  const containers = network?.containers && typeof network.containers === 'object' ? network.containers : {};
  for (const [containerKey, entry] of Object.entries(containers)) {
    if (containerKey === id || containerKey.startsWith(id) || id.startsWith(containerKey)) {
      return { containerId: containerKey, entry };
    }
  }
  return null;
}

function requiredLabelsMatch(actual, expected) {
  const a = normalizedLabelMap(actual);
  const e = normalizedLabelMap(expected);
  for (const [key, value] of Object.entries(e)) {
    if (a[key] !== value) return false;
  }
  return true;
}

function driverStatusList(value) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const label = textOrNull(item[0], 80);
    const detail = textOrNull(item[1], 180);
    if (label && detail) out.push({ label, detail });
    if (out.length >= 8) break;
  }
  return out;
}

function isZeroTarBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function tarHeaderSize(header) {
  const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
  if (!sizeText) return 0;
  const parsed = Number.parseInt(sizeText, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function tarHeaderName(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
  return `${prefix ? `${prefix}/` : ''}${name}`.replace(/^\.\/+/, '');
}

function tarPaddedSize(size) {
  return Math.ceil(size / 512) * 512;
}

function tarWriteString(header, value, offset, length) {
  const text = String(value || '').slice(0, length);
  header.write(text, offset, Math.min(Buffer.byteLength(text), length), 'utf8');
}

function tarWriteOctal(header, value, offset, length) {
  const text = Math.max(0, Number(value) || 0)
    .toString(8)
    .padStart(Math.max(0, length - 1), '0')
    .slice(-(length - 1));
  header.write(text, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function tarFinalizeChecksum(header) {
  for (let i = 148; i < 156; i += 1) header[i] = 32;
  let sum = 0;
  for (const byte of header) sum += byte;
  const text = sum.toString(8).padStart(6, '0').slice(-6);
  header.write(text, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 32;
}

function tarArchiveForEntry(name, data = Buffer.alloc(0), typeflag = '0') {
  const cleanName = String(name || '').replace(/^\/+/, '');
  if (!cleanName || cleanName.includes('\0')) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'archive entry name is invalid');
  }
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  const header = Buffer.alloc(512);
  tarWriteString(header, cleanName, 0, 100);
  tarWriteOctal(header, typeflag === '5' ? 0o755 : 0o644, 100, 8);
  tarWriteOctal(header, 0, 108, 8);
  tarWriteOctal(header, 0, 116, 8);
  tarWriteOctal(header, typeflag === '5' ? 0 : body.length, 124, 12);
  tarWriteOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header[156] = typeflag.charCodeAt(0);
  tarWriteString(header, 'ustar', 257, 6);
  tarWriteString(header, '00', 263, 2);
  tarFinalizeChecksum(header);

  const paddedSize = tarPaddedSize(body.length);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc(paddedSize - body.length),
    Buffer.alloc(1024)
  ]);
}

function immediateChildrenFromTar(archive, directoryPath) {
  if (!Buffer.isBuffer(archive) || archive.length < 512) return [];
  const rootName = path.posix.basename(String(directoryPath || '').replace(/\/+$/u, ''));
  const entries = new Map();

  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroTarBlock(header)) break;

    const size = tarHeaderSize(header);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) break;

    const rawName = tarHeaderName(header).replace(/\/+$/u, '');
    let parts = rawName.split('/').filter(Boolean);
    if (parts[0] === rootName) parts = parts.slice(1);
    if (parts.length > 0) {
      const name = parts[0];
      if (name && name !== '.' && name !== '..' && !name.includes('/')) {
        const typeflag = header[156];
        const type = typeflag === 53 || parts.length > 1 ? 'directory' : 'file';
        const previous = entries.get(name);
        entries.set(name, {
          name,
          type: previous?.type === 'directory' || type === 'directory' ? 'directory' : 'file'
        });
      }
    }

    offset = dataStart + tarPaddedSize(size);
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractFirstRegularFileFromTar(archive, maxBytes) {
  if (!Buffer.isBuffer(archive) || archive.length < 512) return null;

  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroTarBlock(header)) return null;

    const size = tarHeaderSize(header);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) return null;

    const typeflag = header[156];
    if (typeflag === 0 || typeflag === 48) {
      return archive.subarray(dataStart, Math.min(dataEnd, dataStart + maxBytes));
    }

    offset = dataStart + tarPaddedSize(size);
  }

  return null;
}

async function streamToBuffer(stream, maxBytes) {
  if (!stream || typeof stream.on !== 'function') return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  stream.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const err = makeDockerInterfaceError('OUTPUT_TOO_LARGE', 'Container file archive exceeded the read limit');
      try {
        stream.destroy(err);
      } catch {
        // ignore
      }
      return;
    }
    chunks.push(buffer);
  });

  await once(stream, 'end');
  return Buffer.concat(chunks, total);
}

function dockerodeOptionsFromEnv(env) {
  const hostInfo = env?.dockerHost;
  const base = { timeout: 0 };
  if (!hostInfo || hostInfo.kind === 'default') return base;

  if (hostInfo.kind === 'unix' || hostInfo.kind === 'npipe') {
    return { ...base, socketPath: hostInfo.socketPath };
  }

  if (hostInfo.kind === 'tcp' || hostInfo.kind === 'http' || hostInfo.kind === 'https') {
    return {
      ...base,
      host: hostInfo.host,
      port: hostInfo.port,
      protocol: hostInfo.protocol
    };
  }

  return base;
}

export class DockerodeDocker extends DockerInterface {
  /**
   * @param {Object=} options
   * @param {import('../DockerInterface.mjs').DockerEnvironmentInfo=} options.env
   * @param {string=} options.imageRepo
   */
  constructor(options = {}) {
    super({ imageRepo: options?.imageRepo });
    this.env = options?.env || null;

    this.docker = new Dockerode(dockerodeOptionsFromEnv(this.env));
    this.registry = new DockerHubRegistry({ userAgent: 'A0-Launcher' });

    /** @type {Map<string, any>} */
    this._pulls = new Map();
  }

  async getRuntimeDiagnostics() {
    try {
      const [version, info] = await Promise.all([
        Promise.resolve(this.docker.version()),
        Promise.resolve(this.docker.info())
      ]);
      const securityOptions = stringList(info?.SecurityOptions, 16, 180);
      return {
        checkedAt: safeIsoNow(),
        reachable: true,
        dockerHost: textOrNull(this.env?.dockerHost?.raw, 500),
        dockerHostKind: textOrNull(this.env?.dockerHost?.kind, 40),
        dockerFlavor: textOrNull(this.env?.dockerFlavor, 80),
        serverVersion: textOrNull(version?.Version || info?.ServerVersion, 120),
        apiVersion: textOrNull(version?.ApiVersion, 80),
        minApiVersion: textOrNull(version?.MinAPIVersion, 80),
        gitCommit: textOrNull(version?.GitCommit, 80),
        goVersion: textOrNull(version?.GoVersion, 120),
        os: textOrNull(version?.Os || info?.OSType, 80),
        arch: textOrNull(version?.Arch || info?.Architecture, 80),
        operatingSystem: textOrNull(info?.OperatingSystem, 180),
        kernelVersion: textOrNull(info?.KernelVersion, 180),
        dockerRootDir: textOrNull(info?.DockerRootDir, 500),
        storageDriver: textOrNull(info?.Driver, 120),
        loggingDriver: textOrNull(info?.LoggingDriver, 120),
        cgroupDriver: textOrNull(info?.CgroupDriver, 120),
        cgroupVersion: textOrNull(info?.CgroupVersion, 80),
        rootless: securityOptions.some((item) => /rootless/i.test(item)),
        securityOptions,
        containers: {
          total: finiteNumberOrNull(info?.Containers),
          running: finiteNumberOrNull(info?.ContainersRunning),
          paused: finiteNumberOrNull(info?.ContainersPaused),
          stopped: finiteNumberOrNull(info?.ContainersStopped)
        },
        images: finiteNumberOrNull(info?.Images),
        cpus: finiteNumberOrNull(info?.NCPU),
        memoryBytes: finiteNumberOrNull(info?.MemTotal),
        liveRestoreEnabled: typeof info?.LiveRestoreEnabled === 'boolean' ? info.LiveRestoreEnabled : null,
        swarmLocalNodeState: textOrNull(info?.Swarm?.LocalNodeState, 80),
        warnings: stringList(info?.Warnings, 8, 220),
        driverStatus: driverStatusList(info?.DriverStatus)
      };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'getRuntimeDiagnostics', env: this.#envSummary() });
    }
  }

  async listRemoteTags(imageRepo) {
    try {
      const { tags } = await this.registry.listTags((imageRepo || this.imageRepo).trim());
      return tags;
    } catch (error) {
      // Registry errors already carry structured codes; annotate with env context.
      if (error && typeof error === 'object') {
        error.details = { ...(error.details || {}), env: this.#envSummary() };
      }
      throw error;
    }
  }

  async getRemoteDigest(imageRepo, tag) {
    try {
      const r = await this.registry.getDigest((imageRepo || this.imageRepo).trim(), tag);
      return {
        exists: !!r.exists,
        digest: r.digest || null,
        contentType: r.contentType || null,
        rateLimit: r.rateLimit || null
      };
    } catch (error) {
      if (error && typeof error === 'object') {
        error.details = { ...(error.details || {}), env: this.#envSummary() };
      }
      throw error;
    }
  }

  async getRemoteLayerSizes(imageRepo, tag, options = {}) {
    try {
      const desiredArch = (options?.arch || this.env?.arch || process.arch || '').trim();
      const arch = desiredArch === 'x64' ? 'amd64' : desiredArch;
      const desiredOs = (options?.os || this.env?.platform || 'linux').trim() || 'linux';
      const variant = (options?.variant || '').trim() || null;
      const r = await this.registry.getLayerSizes((imageRepo || this.imageRepo).trim(), tag, { os: desiredOs, arch, variant });
      return r;
    } catch (error) {
      if (error && typeof error === 'object') {
        error.details = { ...(error.details || {}), env: this.#envSummary() };
      }
      throw error;
    }
  }

  async listLocalImages(imageRepo) {
    const repo = (imageRepo || this.imageRepo).trim();
    if (!repo) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRepo is required');

    try {
      const images = await Promise.resolve(this.docker.listImages({ all: true }));
      const results = [];

      for (const img of images || []) {
        const repoTags = Array.isArray(img?.RepoTags) ? img.RepoTags : [];
        const repoDigests = Array.isArray(img?.RepoDigests) ? img.RepoDigests : [];
        const id = typeof img?.Id === 'string' ? img.Id : null;
        const sizeBytes = Number.isFinite(Number(img?.Size)) ? Number(img.Size) : null;
        const createdAtMs = Number.isFinite(Number(img?.Created)) ? Number(img.Created) * 1000 : null;

        for (const rt of repoTags) {
          if (typeof rt !== 'string') continue;
          if (!rt.startsWith(`${repo}:`)) continue;
          results.push({
            imageRef: rt,
            tag: rt.slice(repo.length + 1),
            imageId: id,
            sizeBytes,
            createdAt: createdAtMs,
            repoDigests
          });
        }
      }

      return results;
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listLocalImages', repo, env: this.#envSummary() });
    }
  }

  async removeLocalImage(imageRef, options = {}) {
    const ref = (imageRef || '').trim();
    if (!ref) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRef is required');

    try {
      const img = this.docker.getImage(ref);
      await new Promise((resolve, reject) => {
        img.remove({ force: options?.force === true }, (err) => (err ? reject(err) : resolve()));
      });
    } catch (error) {
      throw normalizeDockerError(error, { op: 'removeLocalImage', imageRef: ref, env: this.#envSummary() });
    }
  }

  async pullImage(imageRef, options = {}) {
    const ref = (imageRef || '').trim();
    if (!ref) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRef is required');

    const opId = makeOpId();
    const startedAt = safeIsoNow();

    const pullState = {
      opId,
      imageRef: ref,
      status: 'running',
      progress: null,
      message: null,
      canCancel: true,
      startedAt,
      _layers: new Map(),
      _lastNewLayerAtMs: Date.now(),
      _dlDenomFrozen: 0,
      _xDenomFrozen: 0,
      _lastDlPercent: 0,
      _lastXPercent: 0,
      _stream: null,
      _abortListener: null
    };

    this._pulls.set(opId, pullState);

    const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
    const signal = options?.signal;
    let authconfig = null;

    try {
      if (signal) {
        const listener = () => {
          this.cancelPull(opId).catch(() => {});
        };
        pullState._abortListener = listener;

        if (signal.aborted) {
          await this.cancelPull(opId);
          return { opId, status: 'aborted_client' };
        }

        try {
          signal.addEventListener('abort', listener, { once: true });
        } catch {
          // ignore
        }
      }

      authconfig = await resolveDockerAuthConfigForImage(ref);
      if (pullState.status === 'aborted_client') return { opId, status: 'aborted_client' };

      const pullOptions = authconfig ? { authconfig } : {};
      const stream = await new Promise((resolve, reject) => {
        this.docker.pull(ref, pullOptions, (err, s) => (err ? reject(err) : resolve(s)));
      });

      pullState._stream = stream;
      const abortPullStream = () => {
        if (stream && typeof stream.destroy === 'function') {
          try {
            stream.destroy();
          } catch {
            // ignore
          }
        }
        pullState.status = 'aborted_client';
        pullState.canCancel = false;
        pullState.message = 'aborted_client';
        this._pulls.delete(opId);
      };

      if (pullState.status === 'aborted_client' || signal?.aborted) {
        abortPullStream();
        return { opId, status: 'aborted_client' };
      }

      // Best-effort manifest layer sizes to stabilize denominators and avoid 99% stalls.
      const repo = imageRepoFromRef(ref);
      const tag = tagFromRef(ref);
      /** @type {{layersById: Map<string, number>, totalBytes: number}|null} */
      let prefetched = null;
      if (repo && tag) {
        try {
          const r = await this.getRemoteLayerSizes(repo, tag, { os: 'linux' });
          if (r && r.exists && r.layersById && r.totalBytes > 0) {
            prefetched = { layersById: r.layersById, totalBytes: r.totalBytes };
          }
        } catch {
          // best-effort only
        }
      }
      if (pullState.status === 'aborted_client' || signal?.aborted) {
        abortPullStream();
        return { opId, status: 'aborted_client' };
      }

      if (prefetched) {
        pullState._dlDenomFrozen = prefetched.totalBytes;
        pullState._xDenomFrozen = prefetched.totalBytes;
        for (const [id, size] of prefetched.layersById.entries()) {
          if (!id || !Number.isFinite(Number(size)) || Number(size) <= 0) continue;
          pullState._layers.set(id, {
            id,
            dlCurrent: 0,
            dlTotal: Number(size),
            dlComplete: false,
            xCurrent: 0,
            xTotal: Number(size),
            xComplete: false,
            alreadyExists: false
          });
        }
      }

      await new Promise((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err) => {
            if (pullState.status === 'aborted_client') return resolve();
            if (err) return reject(err);
            return resolve();
          },
          (evt) => {
            // Tolerate events without totals/ids.
            const status = typeof evt?.status === 'string' ? evt.status : null;
            const rawId = typeof evt?.id === 'string' ? evt.id : null;
            // Docker pull streams can emit non-layer ids (for example the tag name).
            // Only treat hex-like ids as layer ids for aggregation.
            const id = rawId && /^[a-f0-9]{12,}$/i.test(rawId) ? rawId.slice(0, 12) : null;
            const current = Number.isFinite(Number(evt?.progressDetail?.current))
              ? Number(evt.progressDetail.current)
              : null;
            const total = Number.isFinite(Number(evt?.progressDetail?.total))
              ? Number(evt.progressDetail.total)
              : null;

            let layerPercent = null;
            if (current !== null && total !== null && total > 0) {
              layerPercent = Math.max(0, Math.min(100, Math.floor((current / total) * 100)));
            }

            const clamp01 = (x) => {
              if (!Number.isFinite(x)) return 0;
              return Math.max(0, Math.min(1, x));
            };

            const statusNorm = (status || '').toLowerCase();
            const isDownloading = statusNorm === 'downloading' || statusNorm.includes('downloading');
            const isExtracting = statusNorm === 'extracting' || statusNorm.includes('extracting');
            const isDownloadComplete = statusNorm.includes('download complete');
            const isPullComplete = statusNorm.includes('pull complete');
            const isAlreadyExists = statusNorm.includes('already exists');
            const isPullingLayer = statusNorm.includes('pulling fs layer');

            // Track per-layer tuples (download + extract) and recompute both ratios each event.
            if (id && !pullState._layers.has(id)) {
              const prefSize = prefetched?.layersById?.get?.(id);
              const seedTotal = Number.isFinite(Number(prefSize)) && Number(prefSize) > 0 ? Number(prefSize) : 0;
              pullState._layers.set(id, {
                id,
                dlCurrent: 0,
                dlTotal: seedTotal,
                dlComplete: false,
                xCurrent: 0,
                xTotal: seedTotal,
                xComplete: false,
                alreadyExists: false
              });
              pullState._lastNewLayerAtMs = Date.now();
            }

            const layer = id ? pullState._layers.get(id) : null;
            if (layer) {
              if (isAlreadyExists) {
                layer.alreadyExists = true;
                layer.dlComplete = true;
                layer.xComplete = true;
                if (layer.dlTotal > 0) layer.dlCurrent = layer.dlTotal;
                if (layer.xTotal > 0) layer.xCurrent = layer.xTotal;
              }

              if (isDownloading) {
                if (total !== null && total > 0) layer.dlTotal = Math.max(layer.dlTotal, total);
                if (current !== null) layer.dlCurrent = Math.max(layer.dlCurrent, current);
                if (layer.dlTotal > 0) layer.dlCurrent = Math.max(0, Math.min(layer.dlCurrent, layer.dlTotal));
                // Seed extract total from download total so Extract can show a stable denominator even before events.
                if (!layer.xTotal && layer.dlTotal > 0) layer.xTotal = layer.dlTotal;
              }

              if (isDownloadComplete) {
                layer.dlComplete = true;
                if (layer.dlTotal > 0) layer.dlCurrent = layer.dlTotal;
              }

              if (isExtracting) {
                if (total !== null && total > 0) layer.xTotal = Math.max(layer.xTotal, total);
                if (current !== null) layer.xCurrent = Math.max(layer.xCurrent, current);
                if (layer.xTotal > 0) layer.xCurrent = Math.max(0, Math.min(layer.xCurrent, layer.xTotal));
              }

              if (isPullComplete) {
                layer.dlComplete = true;
                layer.xComplete = true;
                if (layer.dlTotal > 0) layer.dlCurrent = layer.dlTotal;
                if (layer.xTotal > 0) layer.xCurrent = layer.xTotal;
              }
            }
            const layerCount = pullState._layers.size;
            const nowMs = Date.now();

            const computeTotals = (kind) => {
              let doneBytes = 0;
              let totalBytes = 0;
              let doneLayers = 0;
              for (const st of pullState._layers.values()) {
                const isDone = kind === 'dl' ? (st.dlComplete || st.alreadyExists) : (st.xComplete || st.alreadyExists);
                const totRaw = kind === 'dl' ? st.dlTotal : st.xTotal;
                const curRaw = kind === 'dl' ? st.dlCurrent : st.xCurrent;

                let tot = Number.isFinite(Number(totRaw)) ? Number(totRaw) : 0;
                let cur = Number.isFinite(Number(curRaw)) ? Number(curRaw) : 0;

                if (tot <= 0) {
                  if (isDone) {
                    // Unknown size but finished (cached); treat as 1 unit so we still advance.
                    tot = 1;
                    cur = 1;
                  } else {
                    continue;
                  }
                }

                totalBytes += tot;
                doneBytes += isDone ? tot : Math.min(cur, tot);
                if (isDone || cur >= tot) doneLayers += 1;
              }

              const frozen = kind === 'dl' ? Number(pullState._dlDenomFrozen) || 0 : Number(pullState._xDenomFrozen) || 0;
              const denom = frozen > 0 ? frozen : totalBytes;
              const percent = denom > 0 ? Math.max(0, Math.min(100, Math.round((doneBytes / denom) * 100))) : null;
              return { doneBytes, totalBytes, doneLayers, denom, percent };
            };

            // Freeze denominators after 1.5s with no new layers (prevents jitter when totals appear late).
            const timeSinceNewLayer = Math.max(0, nowMs - (Number(pullState._lastNewLayerAtMs) || nowMs));
            const FREEZE_DELAY_MS = 1500;
            if (!prefetched && timeSinceNewLayer >= FREEZE_DELAY_MS) {
              if (!pullState._dlDenomFrozen) {
                const dlNow = computeTotals('dl');
                if (dlNow.totalBytes > 0) pullState._dlDenomFrozen = dlNow.totalBytes;
              }
              if (!pullState._xDenomFrozen) {
                const xNow = computeTotals('x');
                if (xNow.totalBytes > 0) pullState._xDenomFrozen = xNow.totalBytes;
              }
            }

            const dlAgg = computeTotals('dl');
            const xAgg = computeTotals('x');

            let downloadProgress = dlAgg.percent;
            let extractProgress = xAgg.percent;

            if (typeof downloadProgress === 'number') {
              downloadProgress = Math.max(Number(pullState._lastDlPercent) || 0, downloadProgress);
              pullState._lastDlPercent = downloadProgress;
            }
            if (typeof extractProgress === 'number') {
              extractProgress = Math.max(Number(pullState._lastXPercent) || 0, extractProgress);
              pullState._lastXPercent = extractProgress;
            }

            pullState.message = status;
            pullState.progress = downloadProgress;

            if (onProgress) {
              try {
                onProgress({
                  opId,
                  imageRef: ref,
                  status,
                  id,
                  current,
                  total,
                  layerProgress: layerPercent,
                  downloadProgress,
                  extractProgress,
                  downloadLayersTotal: layerCount,
                  downloadLayersDone: dlAgg.doneLayers,
                  extractLayersTotal: layerCount,
                  extractLayersDone: xAgg.doneLayers,
                  rawStatus: status,
                  pullingLayer: !!(isPullingLayer && id)
                });
              } catch {
                // do not let UI callback break the pull
              }
            }
          }
        );
      });

      if (pullState.status === 'aborted_client') {
        return { opId, status: 'aborted_client' };
      }

      pullState.status = 'completed';
      pullState.canCancel = false;
      pullState.progress = 100;
      return { opId, status: 'completed' };
    } catch (error) {
      if (pullState.status === 'aborted_client') {
        return { opId, status: 'aborted_client' };
      }
      pullState.status = 'failed';
      pullState.canCancel = false;
      throw normalizeDockerError(error, {
        op: 'pullImage',
        imageRef: ref,
        repo: imageRepoFromRef(ref),
        tag: tagFromRef(ref),
        registryAuth: authconfig ? 'present' : 'absent',
        env: this.#envSummary()
      });
    } finally {
      if (signal && pullState._abortListener) {
        try {
          signal.removeEventListener('abort', pullState._abortListener);
        } catch {
          // ignore
        }
      }
      // Keep completed/failed pulls out of the "in-flight" set.
      if (pullState.status !== 'running') {
        this._pulls.delete(opId);
      }
    }
  }

  async getPulls() {
    return Array.from(this._pulls.values()).map((p) => ({
      opId: p.opId,
      imageRef: p.imageRef,
      status: p.status,
      progress: p.progress,
      message: p.message,
      canCancel: !!p.canCancel,
      startedAt: p.startedAt
    }));
  }

  async cancelPull(opId) {
    const id = (opId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'opId is required');

    const p = this._pulls.get(id);
    if (!p) return { canceled: false };
    if (p.status !== 'running') return { canceled: false };

    const s = p._stream;
    if (s && typeof s.destroy === 'function') {
      // Best-effort client-side abort; daemon may continue briefly while the
      // Docker API request is torn down.
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }

    p.status = 'aborted_client';
    p.canCancel = false;
    p.message = 'aborted_client';
    if (s) this._pulls.delete(id);
    return { canceled: true };
  }

  async listContainers(imageRepo) {
    const repo = (imageRepo || this.imageRepo).trim();
    if (!repo) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRepo is required');

    try {
      const containers = await Promise.resolve(this.docker.listContainers({ all: true }));
      const results = [];

      for (const c of containers || []) {
        const image = typeof c?.Image === 'string' ? c.Image : '';
        const names = Array.isArray(c?.Names) ? c.Names : [];
        const name = typeof names[0] === 'string' ? names[0].replace(/^\//, '') : null;
        const labels = c?.Labels && typeof c.Labels === 'object' ? c.Labels : {};
        const ports = Array.isArray(c?.Ports) ? c.Ports : [];
        const isRepoImage = image.startsWith(`${repo}:`);
        const isManagedContainer = labels['a0.launcher.managed'] === 'true';
        if (!isRepoImage && !isManagedContainer) continue;

        const uiPort = bestUiPortFromList(ports);
        const tag = isRepoImage
          ? image.slice(repo.length + 1)
          : labels['a0.launcher.versionTag'] || tagFromRef(image) || image;
        results.push({
          containerId: c?.Id || null,
          containerName: name,
          instanceName: typeof labels['a0.launcher.instanceName'] === 'string' ? labels['a0.launcher.instanceName'] : null,
          imageRef: image,
          tag,
          versionTag: tag,
          state: c?.State || null,
          status: c?.Status || null,
          createdAt: Number.isFinite(Number(c?.Created)) ? Number(c.Created) * 1000 : null,
          labels,
          ports: ports.map((p) => ({
            privatePort: Number.isFinite(Number(p?.PrivatePort)) ? Number(p.PrivatePort) : null,
            publicPort: Number.isFinite(Number(p?.PublicPort)) ? Number(p.PublicPort) : null,
            type: typeof p?.Type === 'string' ? p.Type : null,
            ip: typeof p?.IP === 'string' ? p.IP : null
          })),
          uiUrl: uiPort ? `http://127.0.0.1:${uiPort.publicPort}/` : null
        });
      }

      return results;
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listContainers', repo, env: this.#envSummary() });
    }
  }

  async listVolumes() {
    try {
      const res = await Promise.resolve(this.docker.listVolumes());
      const volumes = Array.isArray(res?.Volumes) ? res.Volumes : [];
      return volumes.map((v) => ({
        name: typeof v?.Name === 'string' ? v.Name : '',
        driver: typeof v?.Driver === 'string' ? v.Driver : '',
        mountpoint: typeof v?.Mountpoint === 'string' ? v.Mountpoint : '',
        scope: typeof v?.Scope === 'string' ? v.Scope : '',
        createdAt: typeof v?.CreatedAt === 'string' ? v.CreatedAt : null,
        labels: v?.Labels && typeof v.Labels === 'object' ? v.Labels : {}
      }));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listVolumes', env: this.#envSummary() });
    }
  }

  async removeVolume(volumeName) {
    const name = (volumeName || '').trim();
    if (!name) throw makeDockerInterfaceError('INVALID_INPUT', 'volumeName is required');
    try {
      const volume = this.docker.getVolume(name);
      await Promise.resolve(volume.remove());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'removeVolume', volumeName: name, env: this.#envSummary() });
    }
  }

  async pruneVolumes() {
    try {
      return await Promise.resolve(this.docker.pruneVolumes());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'pruneVolumes', env: this.#envSummary() });
    }
  }

  async ensureNetwork(name, options = {}) {
    const networkName = cleanDockerResourceName(name, 'networkName');
    const labels = normalizedLabelMap(options?.labels);
    const driver = String(options?.driver || 'bridge').trim() || 'bridge';

    try {
      const existing = await this.inspectNetwork(networkName).catch((error) => {
        if (Number(error?.details?.statusCode) === 404 || error?.code === 'NOT_FOUND') return null;
        throw error;
      });
      if (existing) {
        if (!requiredLabelsMatch(existing.labels, labels)) {
          throw makeDockerInterfaceError('NETWORK_CONFLICT', 'Docker network name is already in use', {
            op: 'ensureNetwork',
            networkName,
            env: this.#envSummary()
          });
        }
        return { ...existing, created: false };
      }

      const created = await Promise.resolve(this.docker.createNetwork({
        Name: networkName,
        Driver: driver,
        Labels: labels
      }));
      const network = typeof created?.inspect === 'function'
        ? formatNetworkInspect(await Promise.resolve(created.inspect()))
        : await this.inspectNetwork(networkName);
      return { ...network, created: true };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'ensureNetwork', networkName, env: this.#envSummary() });
    }
  }

  async inspectNetwork(nameOrId) {
    const networkId = cleanDockerResourceName(nameOrId, 'networkName');
    try {
      const network = this.docker.getNetwork(networkId);
      return formatNetworkInspect(await Promise.resolve(network.inspect()));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'inspectNetwork', networkName: networkId, env: this.#envSummary() });
    }
  }

  async connectContainerToNetwork(nameOrId, containerId, options = {}) {
    const networkId = cleanDockerResourceName(nameOrId, 'networkName');
    const id = cleanDockerResourceName(containerId, 'containerId');
    const aliases = normalizedNetworkAliases(options?.aliases);

    try {
      const network = this.docker.getNetwork(networkId);
      const before = formatNetworkInspect(await Promise.resolve(network.inspect()));
      const existing = findNetworkContainer(before, id);
      if (existing) {
        const currentAliases = new Set(stringList(existing.entry?.aliases, 32, 120));
        const missingAliases = aliases.filter((alias) => !currentAliases.has(alias));
        if (missingAliases.length) {
          throw makeDockerInterfaceError('NETWORK_ALIAS_CONFLICT', 'Container is already attached without the requested network aliases', {
            op: 'connectContainerToNetwork',
            networkName: networkId,
            containerId: id,
            aliases,
            missingAliases,
            env: this.#envSummary()
          });
        }
        return { connected: false, alreadyConnected: true, network: before };
      }

      const payload = {
        Container: id
      };
      if (aliases.length) payload.EndpointConfig = { Aliases: aliases };
      await Promise.resolve(network.connect(payload));
      const after = formatNetworkInspect(await Promise.resolve(network.inspect()));
      return { connected: true, alreadyConnected: false, network: after };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'connectContainerToNetwork',
        networkName: networkId,
        containerId: id,
        env: this.#envSummary()
      });
    }
  }

  async disconnectContainerFromNetwork(nameOrId, containerId, options = {}) {
    const networkId = cleanDockerResourceName(nameOrId, 'networkName');
    const id = cleanDockerResourceName(containerId, 'containerId');
    const force = options?.force !== false;

    try {
      const network = this.docker.getNetwork(networkId);
      let before = null;
      try {
        before = formatNetworkInspect(await Promise.resolve(network.inspect()));
      } catch (error) {
        if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') {
          return { disconnected: false, missingNetwork: true };
        }
        throw error;
      }

      if (!findNetworkContainer(before, id)) {
        return { disconnected: false, missingNetwork: false };
      }

      await Promise.resolve(network.disconnect({ Container: id, Force: force }));
      return { disconnected: true, missingNetwork: false };
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') {
        return { disconnected: false, missingNetwork: true };
      }
      throw normalizeDockerError(error, {
        op: 'disconnectContainerFromNetwork',
        networkName: networkId,
        containerId: id,
        env: this.#envSummary()
      });
    }
  }

  async createContainer(createOptions) {
    if (!createOptions || typeof createOptions !== 'object') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'createOptions must be an object');
    }

    try {
      const c = await Promise.resolve(this.docker.createContainer(createOptions));
      const containerId = typeof c?.id === 'string' ? c.id : typeof c?.Id === 'string' ? c.Id : null;
      if (!containerId) {
        throw makeDockerInterfaceError('DOCKER_ERROR', 'Docker did not return a container id', {
          op: 'createContainer',
          env: this.#envSummary()
        });
      }
      return { containerId };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'createContainer', env: this.#envSummary() });
    }
  }

  async renameContainer(containerId, newName) {
    const id = (containerId || '').trim();
    const name = (newName || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    if (!name) throw makeDockerInterfaceError('INVALID_INPUT', 'newName is required');

    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.rename({ name }));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'renameContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async inspectContainer(containerId) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    try {
      const c = this.docker.getContainer(id);
      return await Promise.resolve(c.inspect());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'inspectContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async probeHttpFromContainer(containerId, url, options = {}) {
    const id = cleanDockerResourceName(containerId, 'containerId');
    const targetUrl = normalizeProbeHttpUrl(url);
    const timeoutMs = clampHttpProbeTimeoutMs(options?.timeoutMs);

    try {
      const c = this.docker.getContainer(id);
      const exec = await new Promise((resolve, reject) => {
        c.exec({
          Cmd: ['/bin/sh', '-lc', HTTP_PROBE_SCRIPT, 'a0-http-probe', targetUrl, String(timeoutMs)],
          AttachStdout: true,
          AttachStderr: true,
          Tty: false
        }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const stream = await new Promise((resolve, reject) => {
        exec.start({ Detach: false, Tty: false }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const output = demuxDockerExecBuffer(await streamToBuffer(stream, 16384));
      const stdoutText = output.stdoutText;
      const stderrText = output.stderrText;

      const inspect = typeof exec.inspect === 'function' ? await Promise.resolve(exec.inspect()) : {};
      const exitCode = Number.isFinite(Number(inspect?.ExitCode)) ? Number(inspect.ExitCode) : null;
      const parsed = parseHttpProbeOutput(stdoutText);
      if (parsed) {
        return {
          ...parsed,
          exitCode,
          timedOut: false
        };
      }

      return {
        reachable: false,
        statusCode: null,
        elapsedMs: null,
        error: textOrNull(stderrText, 300) || textOrNull(stdoutText, 300) || (exitCode === null ? 'Probe failed' : `Probe exited with code ${exitCode}`),
        exitCode,
        timedOut: false
      };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'probeHttpFromContainer', containerId: id, url: targetUrl, env: this.#envSummary() });
    }
  }

  async postJsonWithCsrfFromContainer(containerId, baseUrl, postPath, payload, options = {}) {
    const id = cleanDockerResourceName(containerId, 'containerId');
    const targetBaseUrl = normalizeProbeHttpUrl(baseUrl);
    const targetPath = normalizeHttpRequestPath(postPath, 'path');
    const csrfPath = normalizeHttpRequestPath(options?.csrfPath || '/api/csrf_token', 'csrfPath');
    const origin = normalizeHttpOrigin(options?.origin || 'http://localhost');
    const timeoutMs = clampHttpProbeTimeoutMs(options?.timeoutMs || 8000);
    const payloadBase64 = normalizeJsonPayloadBase64(payload);

    try {
      const c = this.docker.getContainer(id);
      const exec = await new Promise((resolve, reject) => {
        c.exec({
          Cmd: [
            '/bin/sh',
            '-lc',
            HTTP_JSON_CSRF_POST_SCRIPT,
            'a0-json-post',
            targetBaseUrl,
            targetPath,
            payloadBase64,
            csrfPath,
            origin,
            String(timeoutMs)
          ],
          AttachStdout: true,
          AttachStderr: true,
          Tty: false
        }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const stream = await new Promise((resolve, reject) => {
        exec.start({ Detach: false, Tty: false }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const output = demuxDockerExecBuffer(await streamToBuffer(stream, 32768));
      const stdoutText = output.stdoutText;
      const stderrText = output.stderrText;
      const inspect = typeof exec.inspect === 'function' ? await Promise.resolve(exec.inspect()) : {};
      const exitCode = Number.isFinite(Number(inspect?.ExitCode)) ? Number(inspect.ExitCode) : null;
      const parsed = parseJsonPostOutput(stdoutText);
      if (parsed) {
        return {
          ...parsed,
          exitCode
        };
      }

      return {
        ok: false,
        statusCode: null,
        elapsedMs: null,
        responseText: '',
        responseJson: null,
        error: textOrNull(stderrText, 500) || textOrNull(stdoutText, 500) || (exitCode === null ? 'POST failed' : `POST exited with code ${exitCode}`),
        exitCode
      };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'postJsonWithCsrfFromContainer',
        containerId: id,
        baseUrl: targetBaseUrl,
        path: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async sendA2aMessageFromContainer(containerId, agentUrl, message, options = {}) {
    const id = cleanDockerResourceName(containerId, 'containerId');
    const targetUrl = normalizeProbeHttpUrl(agentUrl);
    const messageBase64 = normalizeTextPayloadBase64(message, 'message');
    const timeoutMs = clampA2aMessageTimeoutMs(options?.timeoutMs || 30000);
    const waitMs = Math.max(0, Math.min(180000, Math.floor(Number(options?.waitMs ?? 60000) || 60000)));
    const pollIntervalMs = Math.max(250, Math.min(10000, Math.floor(Number(options?.pollIntervalMs ?? 2000) || 2000)));

    try {
      const c = this.docker.getContainer(id);
      const exec = await new Promise((resolve, reject) => {
        c.exec({
          Cmd: [
            '/bin/sh',
            '-lc',
            A2A_MESSAGE_SCRIPT,
            'a0-a2a-message',
            targetUrl,
            messageBase64,
            String(timeoutMs),
            String(waitMs),
            String(pollIntervalMs)
          ],
          AttachStdout: true,
          AttachStderr: true,
          Tty: false
        }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const stream = await new Promise((resolve, reject) => {
        exec.start({ Detach: false, Tty: false }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const output = demuxDockerExecBuffer(await streamToBuffer(stream, 1024 * 1024 + 8192));
      const stdoutText = output.stdoutText;
      const stderrText = output.stderrText;
      const inspect = typeof exec.inspect === 'function' ? await Promise.resolve(exec.inspect()) : {};
      const exitCode = Number.isFinite(Number(inspect?.ExitCode)) ? Number(inspect.ExitCode) : null;
      const parsed = parseA2aMessageOutput(stdoutText);
      if (parsed) {
        return {
          ...parsed,
          exitCode
        };
      }

      return {
        ok: false,
        statusCode: null,
        elapsedMs: null,
        taskId: '',
        contextId: '',
        state: '',
        assistantText: '',
        responseText: '',
        responseJson: null,
        error: textOrNull(stderrText, 500) || textOrNull(stdoutText, 500) || (exitCode === null ? 'A2A message failed' : `A2A message exited with code ${exitCode}`),
        pending: false,
        exitCode
      };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'sendA2aMessageFromContainer',
        containerId: id,
        agentUrl: redactTokenizedA2aUrl(targetUrl),
        env: this.#envSummary()
      });
    }
  }

  async pollA2aTaskFromContainer(containerId, agentUrl, taskId, options = {}) {
    const id = cleanDockerResourceName(containerId, 'containerId');
    const targetUrl = normalizeProbeHttpUrl(agentUrl);
    const cleanTaskId = normalizeA2aTaskId(taskId);
    const timeoutMs = clampA2aMessageTimeoutMs(options?.timeoutMs || 30000);
    const waitMs = Math.max(0, Math.min(300000, Math.floor(Number(options?.waitMs ?? 60000) || 60000)));
    const pollIntervalMs = Math.max(250, Math.min(10000, Math.floor(Number(options?.pollIntervalMs ?? 2000) || 2000)));

    try {
      const c = this.docker.getContainer(id);
      const exec = await new Promise((resolve, reject) => {
        c.exec({
          Cmd: [
            '/bin/sh',
            '-lc',
            A2A_TASK_POLL_SCRIPT,
            'a0-a2a-task-poll',
            targetUrl,
            cleanTaskId,
            String(timeoutMs),
            String(waitMs),
            String(pollIntervalMs)
          ],
          AttachStdout: true,
          AttachStderr: true,
          Tty: false
        }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const stream = await new Promise((resolve, reject) => {
        exec.start({ Detach: false, Tty: false }, (err, value) => (err ? reject(err) : resolve(value)));
      });

      const output = demuxDockerExecBuffer(await streamToBuffer(stream, 1024 * 1024 + 8192));
      const stdoutText = output.stdoutText;
      const stderrText = output.stderrText;
      const inspect = typeof exec.inspect === 'function' ? await Promise.resolve(exec.inspect()) : {};
      const exitCode = Number.isFinite(Number(inspect?.ExitCode)) ? Number(inspect.ExitCode) : null;
      const parsed = parseA2aMessageOutput(stdoutText);
      if (parsed) {
        return {
          ...parsed,
          exitCode
        };
      }

      return {
        ok: false,
        statusCode: null,
        elapsedMs: null,
        taskId: cleanTaskId,
        contextId: '',
        state: '',
        assistantText: '',
        responseText: '',
        responseJson: null,
        error: textOrNull(stderrText, 500) || textOrNull(stdoutText, 500) || (exitCode === null ? 'A2A task poll failed' : `A2A task poll exited with code ${exitCode}`),
        pending: false,
        exitCode
      };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'pollA2aTaskFromContainer',
        containerId: id,
        agentUrl: redactTokenizedA2aUrl(targetUrl),
        taskId: cleanTaskId,
        env: this.#envSummary()
      });
    }
  }

  async readContainerTextFile(containerId, filePath, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(filePath);
    const maxBytes = clampReadBytes(options?.maxBytes);

    try {
      const c = this.docker.getContainer(id);
      const stream = await new Promise((resolve, reject) => {
        c.getArchive({ path: targetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
      const archive = await streamToBuffer(stream, maxBytes + 8192);
      const fileBytes = extractFirstRegularFileFromTar(archive, maxBytes);
      return fileBytes ? fileBytes.toString('utf8') : null;
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') return null;
      throw normalizeDockerError(error, { op: 'readContainerTextFile', containerId: id, filePath: targetPath, env: this.#envSummary() });
    }
  }

  async writeContainerTextFile(containerId, filePath, text) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(filePath);
    const parentPath = path.posix.dirname(targetPath);
    const fileName = path.posix.basename(targetPath);
    if (!fileName || fileName === '.' || fileName === '..') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'filePath must include a file name');
    }

    try {
      const c = this.docker.getContainer(id);
      const archive = tarArchiveForEntry(fileName, Buffer.from(String(text || ''), 'utf8'), '0');
      await new Promise((resolve, reject) => {
        c.putArchive(Readable.from(archive), { path: parentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { written: true };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'writeContainerTextFile',
        containerId: id,
        filePath: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async ensureContainerDirectory(containerId, directoryPath) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(directoryPath).replace(/\/+$/u, '') || '/';
    if (targetPath === '/') return { created: false };
    const parentPath = path.posix.dirname(targetPath);
    const dirName = path.posix.basename(targetPath);
    if (!dirName || dirName === '.' || dirName === '..') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'directoryPath must include a directory name');
    }

    try {
      const c = this.docker.getContainer(id);
      const archive = tarArchiveForEntry(`${dirName}/`, Buffer.alloc(0), '5');
      await new Promise((resolve, reject) => {
        c.putArchive(Readable.from(archive), { path: parentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { created: true };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'ensureContainerDirectory',
        containerId: id,
        directoryPath: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async listContainerDirectory(containerId, directoryPath, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(directoryPath);
    const maxBytes = clampArchiveListBytes(options?.maxBytes);

    try {
      const c = this.docker.getContainer(id);
      const stream = await new Promise((resolve, reject) => {
        c.getArchive({ path: targetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
      const archive = await streamToBuffer(stream, maxBytes);
      return immediateChildrenFromTar(archive, targetPath);
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') return [];
      throw normalizeDockerError(error, {
        op: 'listContainerDirectory',
        containerId: id,
        directoryPath: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async copyContainerPathToContainer(sourceContainerId, sourcePath, targetContainerId, targetPath) {
    const sourceId = (sourceContainerId || '').trim();
    const targetId = (targetContainerId || '').trim();
    if (!sourceId) throw makeDockerInterfaceError('INVALID_INPUT', 'sourceContainerId is required');
    if (!targetId) throw makeDockerInterfaceError('INVALID_INPUT', 'targetContainerId is required');

    const sourceTargetPath = validateContainerFilePath(sourcePath);
    const targetParentPath = validateContainerFilePath(targetPath);

    try {
      const source = this.docker.getContainer(sourceId);
      const target = this.docker.getContainer(targetId);
      const stream = await new Promise((resolve, reject) => {
        source.getArchive({ path: sourceTargetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
      await new Promise((resolve, reject) => {
        target.putArchive(stream, { path: targetParentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { copied: true };
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') return { copied: false };
      throw normalizeDockerError(error, {
        op: 'copyContainerPathToContainer',
        sourceContainerId: sourceId,
        targetContainerId: targetId,
        sourcePath: sourceTargetPath,
        targetPath: targetParentPath,
        env: this.#envSummary()
      });
    }
  }

  async getContainerPathArchive(containerId, sourcePath) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    const sourceTargetPath = validateContainerFilePath(sourcePath);

    try {
      const source = this.docker.getContainer(id);
      return await new Promise((resolve, reject) => {
        source.getArchive({ path: sourceTargetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'getContainerPathArchive',
        containerId: id,
        sourcePath: sourceTargetPath,
        env: this.#envSummary()
      });
    }
  }

  async putContainerPathArchive(containerId, targetPath, archiveStream) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    const targetParentPath = validateContainerFilePath(targetPath);
    if (!archiveStream || typeof archiveStream.pipe !== 'function') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'archiveStream is required');
    }

    try {
      const target = this.docker.getContainer(id);
      await new Promise((resolve, reject) => {
        target.putArchive(archiveStream, { path: targetParentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { imported: true };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'putContainerPathArchive',
        containerId: id,
        targetPath: targetParentPath,
        env: this.#envSummary()
      });
    }
  }

  async commitContainer(containerId, imageRef, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const ref = (imageRef || '').trim();
    const { repo, tag } = splitTaggedImageRef(ref);

    try {
      const c = this.docker.getContainer(id);
      const result = await new Promise((resolve, reject) => {
        c.commit(
          {
            repo,
            tag,
            pause: options?.pause !== false,
            comment: typeof options?.comment === 'string' ? options.comment : '',
            author: typeof options?.author === 'string' ? options.author : ''
          },
          (err, image) => (err ? reject(err) : resolve(image))
        );
      });
      return {
        imageRef: ref,
        imageId: typeof result?.Id === 'string' ? result.Id : null
      };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'commitContainer', containerId: id, imageRef: ref, env: this.#envSummary() });
    }
  }

  async readContainerLogs(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    try {
      return await dockerodeReadContainerLogs(this.docker, id, options);
    } catch (error) {
      throw normalizeDockerError(error, { op: 'readContainerLogs', containerId: id, env: this.#envSummary() });
    }
  }

  async followContainerLogs(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    try {
      return await dockerodeFollowContainerLogs(this.docker, id, options);
    } catch (error) {
      throw normalizeDockerError(error, { op: 'followContainerLogs', containerId: id, env: this.#envSummary() });
    }
  }

  async startContainer(containerId) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.start());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'startContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async stopContainer(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.stop(options));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'stopContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async restartContainer(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.restart(options));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'restartContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async deleteContainer(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.remove(options));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'deleteContainer', containerId: id, env: this.#envSummary() });
    }
  }

  #envSummary() {
    return {
      platform: this.env?.platform || process.platform,
      arch: this.env?.arch || process.arch,
      dockerHostKind: this.env?.dockerHost?.kind || 'unknown',
      dockerAvailable: !!this.env?.dockerAvailable,
      dockerFlavor: this.env?.dockerFlavor || 'unknown',
      daemonVersion: this.env?.daemonVersion || null
    };
  }
}
