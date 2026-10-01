// Fixed same-origin setup requests using the selected tab's authenticated session.
// No credentials or arbitrary endpoint/command reaches the renderer.
const ACTIONS = new Set(['status', 'read', 'claim', 'confirm', 'cancel']);

async function readJSON(response) {
  if (!response.ok || response.status >= 300) {
    const error = new Error(response.status === 404
      ? 'Update Agent Zero for shared setup. Local host settings remain available.'
      : response.status === 400 ? 'Check the setup code and selected server, then try again.'
      : 'Sign in to this Instance, then check setup again.');
    error.code = response.status === 404 ? 'SETUP_UNSUPPORTED' : 'SETUP_REQUEST_FAILED';
    throw error;
  }
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('Setup response is too large.');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function requestHostSetup({ fetch, origin, action, payload = {}, current = () => true }) {
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('Invalid Instance origin.');
  }
  if (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('Use HTTPS for a remote Instance.');
  }
  if (!ACTIONS.has(action)) throw new Error('Unsupported setup action.');
  if (!target.pathname.endsWith('/')) target.pathname += '/';
  const body = { action };
  if (action === 'claim') {
    if (typeof payload.code !== 'string' || !/^[A-Za-z2-9 -]{12,16}$/.test(payload.code)) throw new Error('Enter the setup code from the other device.');
    Object.assign(body, { code: payload.code, host_id: payload.host_id, host_label: payload.host_label, claim_id: payload.claim_id });
  } else if (action !== 'status') {
    if (typeof payload.request_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(payload.request_id)) throw new Error('Invalid setup request.');
    body.request_id = payload.request_id;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const options = { redirect: 'manual', credentials: 'include', signal: controller.signal };
  try {
    const csrf = await readJSON(await fetch(new URL('api/csrf_token', target).href,
      { ...options, headers: { Origin: target.origin, Accept: 'application/json' } }));
    if (!current() || csrf.ok !== true || typeof csrf.token !== 'string') throw new Error('Instance session changed.');
    const result = await readJSON(await fetch(new URL('api/plugins/_a0_connector/v1/host_setup', target).href, {
      ...options, method: 'POST', headers: { Origin: target.origin, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }));
    if (!current() || result.version !== 1 || !/^[a-f0-9]{32}$/.test(result.server_id)) throw new Error('Instance setup changed.');
    return result;
  } finally { clearTimeout(timeout); }
}

module.exports = { requestHostSetup };
