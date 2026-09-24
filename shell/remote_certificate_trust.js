'use strict';

const net = require('node:net');
const { X509Certificate } = require('node:crypto');

// A Remote Instance may sit behind a certificate the system does not trust: a
// self-signed one, or one issued by a private CA. Such an Instance can be
// neither opened, nor logged in to, nor health-checked.
//
// A saved Remote Instance can opt in to accepting such a certificate. The rule
// forgives exactly one thing, an issuer the system does not know. The
// certificate must still name the host and be inside its validity window.
//
// The Launcher reaches an Instance through two network stacks, so the rule has
// two thin adapters: a Chromium session verifier (tabs, session.fetch) and a
// check of a node:https socket (the health probe).

// Values the setCertificateVerifyProc callback accepts.
const CERTIFICATE_ACCEPT = 0;
const CERTIFICATE_USE_CHROMIUM_RESULT = -3;

// net::ERR_CERT_AUTHORITY_INVALID. Chromium reports only the most serious
// problem of a certificate, and this one hides a wrong name or an expired date,
// so both are checked again here.
const ERR_CERT_AUTHORITY_INVALID = -202;

// The OpenSSL verification errors that mean "unknown issuer" and nothing else.
const NODE_UNKNOWN_ISSUER_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]);

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

// The Chromium verifier sees a host name, not a port, so trust is kept per
// host. Only an https URL has a certificate to trust.
function certificateHostFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? normalizeHostname(url.hostname) : '';
  } catch {
    return '';
  }
}

function trustedHostsFromRemoteInstances(remoteInstances) {
  const hosts = new Set();
  for (const remote of Array.isArray(remoteInstances) ? remoteInstances : []) {
    if (remote?.allowUntrustedCertificate !== true) continue;
    const host = certificateHostFromUrl(remote.url);
    if (host) hosts.add(host);
  }
  return hosts;
}

function parseCertificate(pem) {
  try {
    return new X509Certificate(String(pem || ''));
  } catch {
    return null;
  }
}

// Names are matched the way browsers do: subject alternative names only, and
// no partial wildcards such as "a0*.example.com".
function certificateFitsHost(certificate, hostname, now = new Date()) {
  const host = normalizeHostname(hostname);
  if (!certificate || !host) return false;
  const named = net.isIP(host)
    ? certificate.checkIP(host)
    : certificate.checkHost(host, { subject: 'never', partialWildcards: false });
  if (!named) return false;
  const time = now.getTime();
  return time >= Date.parse(certificate.validFrom) && time <= Date.parse(certificate.validTo);
}

// The Chromium side of the rule: the opted-in hosts and the session verifier.
//
// Chromium caches each verdict for 30 minutes, and Electron cannot clear that
// cache. So for every host whose verdict hangs on the opt-in, remember which
// opt-in the cached verdict was made with; an opt-in changed since then only
// applies after the Launcher restarts.
function createCertificateTrust({ now = () => new Date() } = {}) {
  let trustedHosts = new Set();
  const cachedOptIn = new Map();

  // A session.setCertificateVerifyProc callback. It can only turn Chromium's
  // "unknown issuer" into an acceptance; any other case, and any doubt, keeps
  // Chromium's own verdict.
  function verify(request, callback) {
    let verdict = CERTIFICATE_USE_CHROMIUM_RESULT;
    try {
      const hostname = normalizeHostname(request?.hostname);
      if (request?.errorCode === ERR_CERT_AUTHORITY_INVALID
        && certificateFitsHost(parseCertificate(request.certificate?.data), hostname, now())) {
        const trusted = trustedHosts.has(hostname);
        if (trusted) verdict = CERTIFICATE_ACCEPT;
        cachedOptIn.set(hostname, trusted);
      }
    } catch {
      // keep Chromium's verdict
    }
    callback(verdict);
  }

  return {
    verify,
    update(remoteInstances) {
      trustedHosts = trustedHostsFromRemoteInstances(remoteInstances);
    },
    restartRequired(instanceUrl) {
      const host = certificateHostFromUrl(instanceUrl);
      return cachedOptIn.has(host) && cachedOptIn.get(host) !== trustedHosts.has(host);
    }
  };
}

// For a node:https request to an Instance that opted in. Such a request runs
// with rejectUnauthorized: false, and its socket is judged here instead.
function tlsSocketAcceptable(socket, hostname, now = new Date()) {
  if (socket?.authorized === true) return true;
  if (!NODE_UNKNOWN_ISSUER_ERRORS.has(String(socket?.authorizationError || ''))) return false;
  return certificateFitsHost(socket.getPeerX509Certificate?.(), hostname, now);
}

module.exports = {
  CERTIFICATE_ACCEPT,
  CERTIFICATE_USE_CHROMIUM_RESULT,
  ERR_CERT_AUTHORITY_INVALID,
  certificateFitsHost,
  certificateHostFromUrl,
  createCertificateTrust,
  normalizeHostname,
  tlsSocketAcceptable,
  trustedHostsFromRemoteInstances
};
