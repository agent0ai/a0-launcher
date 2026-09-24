const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const { test } = require('node:test');

const {
  CERTIFICATE_ACCEPT,
  CERTIFICATE_USE_CHROMIUM_RESULT,
  ERR_CERT_AUTHORITY_INVALID,
  certificateFitsHost,
  certificateHostFromUrl,
  createCertificateTrust,
  normalizeHostname,
  tlsSocketAcceptable,
  trustedHostsFromRemoteInstances
} = require('./remote_certificate_trust');

// Self-signed test certificates, valid from 2026-09-24 for 100 years.
// SAN: DNS a0.example.com and IP 10.0.0.5.
const PEM = `-----BEGIN CERTIFICATE-----
MIIDNjCCAh6gAwIBAgIUccvGnIhCLwThUBy4noJrQS88qpAwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOYTAuZXhhbXBsZS5jb20wIBcNMjYwOTI0MDAzNzUzWhgP
MjEyNjA4MzEwMDM3NTNaMBkxFzAVBgNVBAMMDmEwLmV4YW1wbGUuY29tMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuyk4pvPz7+GWc5n4C9fZLuQkUhid
9jvm83sJ/AKNK61H9ARvXnozXN/1+BZ3R3jvXe6KXepyPXfBgyJh4Rhu4ADCjTZG
fHR84lQFMVIWPeckT3MbuGY85LCmmd8VNZ1yNCQjvrzLirxsVbfAUgfZEd4BlwnL
YxvCPLXYYEYimONVW65AiFC0TBfxih+cLqVX8IUcQI5LIQOGQW3nXua43T+IvA6J
/seVAdDgHUrfmnneKCSkjEGOrfPGlu4cUmd11h0wQrTQ46kHdx5GZP/SEmajngtK
PqBh/tgZJA1FDU4CJBNFowXMkHY6KFUhYx7AR5wmrSOPP0Z/6n4Q2+DQSwIDAQAB
o3QwcjAdBgNVHQ4EFgQUOKUDV2n+qWpIW67PsMPnc58dMIwwHwYDVR0jBBgwFoAU
OKUDV2n+qWpIW67PsMPnc58dMIwwDwYDVR0TAQH/BAUwAwEB/zAfBgNVHREEGDAW
gg5hMC5leGFtcGxlLmNvbYcECgAABTANBgkqhkiG9w0BAQsFAAOCAQEAK84tWeHn
Xc2czdh0OMMQE3DCCUiCcMqU/iyFd7uDIsRxvy29bIvjomJLYjmK2WmChGRu44E1
p8P4Gi+8BQxpIg+rVojKbJg42+Qacx+cKES/O8TpfwhUJHJcZiak01mtaNRcE5eu
eB4r7bbHIQ/SW9eWHPnRRojIaFlVRVr7TebtfExAu8IRUJFwJA6ZKKBrirXkEd3i
r3AU+4mQkH7OYJ4s4SnnSLYJW6nduZ+OxG8Z4bgSt2N3thfqd6uE9PCMSN/h7tAw
C5zIQwLHuDGi114tHI9IcDyebEfSC57dGOPWxe4FOvWHfEBL24xlBy0T+Jt4D4Jf
Kw8GM+gl8PSX0g==
-----END CERTIFICATE-----`;
// No SAN at all, only CN=a0.example.com.
const CN_ONLY_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUffZNCkmLsNZdPoM2J4Ahs2tw8REwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOYTAuZXhhbXBsZS5jb20wIBcNMjYwOTI0MDE0NDU1WhgP
MjEyNjA4MzEwMTQ0NTVaMBkxFzAVBgNVBAMMDmEwLmV4YW1wbGUuY29tMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArKiPvt9U6oZD/qM6YjVB4JXp/Mz5
zzTK95QWicDurUnb0XlSGgqw09yJCpCBMnhZ6dJUtxjsKvyyAGF/Kq51yi/uuFy+
HXesYV8bvfpRqTmJjh157uShpY6UpkJU8qkQSAgm/er+xrVT1SSqgckrUtFHK+bu
UDJQhL19ZrOcolaRtKb3Ow/0bUjvXFw1yQTxENfD89olz0tDJzU4a9v9fKlxjQfF
tWya2Qkw2UBZbfStRF5h1FFYpLGlvBh6naN/PVfd/lhZVmO4l4IF8HeiugdZtWVU
ecc39Fuzd11u1HfNG8cCE+bunU16KZlolI50i7NoQk6U4VFdoBlUS1pjUQIDAQAB
o1MwUTAdBgNVHQ4EFgQUNUHiNIYQwyR6tN5Bs16gd0y+tscwHwYDVR0jBBgwFoAU
NUHiNIYQwyR6tN5Bs16gd0y+tscwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAl9TuXbiaH7t+jarTqSHPksU42wshtdSBXipeHYoBgWbQPRZS1tQD
sq25opYlxAfZf2qVDBqvL5sWt7hqX7IR+jKCQh+8pHxPukHJf/sqLv9ZxxZInUua
3wI9I95RwzTwL0c8YEOCUNqwPtvIVO3d5DZZ9NDUNCK7d0Ld6haE3QccAgFA0OXj
O6Lp7p3dMiPbGL6CR8mv9Ji47MvzX1M1fE7iatcwjNldJCwz2r9+wox/Lgy9hyPO
5MGUPCTb8rroHI2nGMo0YncC033S7Mv8S/RLlgYZE91fdDYLEIRgzuAUKoRix1FY
fGoqYDZ6pwxkPsCsM9wnmCrDIYehU4GNhw==
-----END CERTIFICATE-----`;
// SAN: DNS a0*.example.com, a partial wildcard.
const PARTIAL_WILDCARD_PEM = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUIzcWoWMDmFaWhh4sE961IoEoMSswDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHcGFydGlhbDAgFw0yNjA5MjQwMTQ0NTZaGA8yMTI2MDgz
MTAxNDQ1NlowEjEQMA4GA1UEAwwHcGFydGlhbDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAOmRNUyghymwtk4Kf9PRPhQ3wlvK/tAfR2bUejUAGLwGOEWZ
8U+Yu9VWaQO1OYJNrdQEaFhUFHOE5cd7qdBe5cuFjztU6e5J/c3V1jtRcBSckX0E
iQ+iyZfHHkGiDAa/NyVhovYJURfRjYKeOvv/N9eud20Fkv9DG7H4fS4j9FkDEPxa
2C8eEApaSSOqfVsspQ631vSxcS5Qu+BUMRoPIrxxlk+fbxBjd05NTjgFIAvLb+Xp
GThkjgHdoaHiIRPhS7VXCClaPUE4D3We5F+rvEKe5YFj4I0sIFdYp3E+1QZB6cKH
RX0a8BDFEmM2W/8Jamw3MrZYDkkWXe0UvQPopjcCAwEAAaNvMG0wHQYDVR0OBBYE
FF8BkC9cE0xAq2g2SrlrxZuSnEF2MB8GA1UdIwQYMBaAFF8BkC9cE0xAq2g2Srlr
xZuSnEF2MA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIPYTAqLmV4YW1wbGUu
Y29tMA0GCSqGSIb3DQEBCwUAA4IBAQB3yxZ+UhxKNbiu3kqYv873P9qA/9l5XT4n
Pq6qNe96GMhM2DqCuDUETiy5xh3jiiAU6wFZRhjXH9QeJO04rh5vLsqhjXBWIMai
h5LDTZJjKf3yHedhy0ragv9FXnM505ZEWkR8F2m4I6ltnSxkF9aNz/hoyujzOaV1
mSVUlYusSDOxQ0lGf6l+tBqlHSWwmdfSrclQuFVRbMjbADE2EC72JtHmturvRe/1
2ur2kuYXLzzPqggPLxXGyMzR3V7oOWwfkxjPNCE/9i0kSCouTIGYiwL/nJSwtKJ6
qkmytOKfe2yhWT1DFfX7wZiQ0Dqgv35DL9H9zBMjDJGT7/HciEcA
-----END CERTIFICATE-----`;

const CERT = new X509Certificate(PEM);
const INSIDE = new Date('2030-01-01T00:00:00Z');
const BEFORE = new Date('2020-01-01T00:00:00Z');
const AFTER = new Date('2200-01-01T00:00:00Z');

function optedIn(...hosts) {
  return hosts.map((host) => ({ url: `https://${host}:5443/`, allowUntrustedCertificate: true }));
}

function check(trust, request) {
  const calls = [];
  trust.verify(request, (value) => calls.push(value));
  assert.equal(calls.length, 1, 'the callback must run exactly once');
  return calls[0];
}

function verdict(request, remoteInstances = optedIn('a0.example.com', '10.0.0.5'), now = INSIDE) {
  const trust = createCertificateTrust({ now: () => now });
  trust.update(remoteInstances);
  return check(trust, request);
}

function request(overrides = {}) {
  return {
    hostname: 'a0.example.com',
    errorCode: ERR_CERT_AUTHORITY_INVALID,
    certificate: { data: PEM },
    ...overrides
  };
}

function socket(overrides = {}) {
  return {
    authorized: false,
    authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    getPeerX509Certificate: () => CERT,
    ...overrides
  };
}

test('host names are compared in one normalized form', () => {
  assert.equal(normalizeHostname(' A0.Example.COM. '), 'a0.example.com');
  assert.equal(normalizeHostname('[::1]'), '::1');
  assert.equal(normalizeHostname(null), '');
  assert.equal(certificateHostFromUrl('https://A0.example.com:5443/path'), 'a0.example.com');
  assert.equal(certificateHostFromUrl('https://[::1]:5443/'), '::1');
  assert.equal(certificateHostFromUrl('http://a0.example.com/'), '');
  assert.equal(certificateHostFromUrl('not a url'), '');
});

test('trusted hosts come only from opted-in https Instances', () => {
  const hosts = trustedHostsFromRemoteInstances([
    { url: 'https://A0.example.com:5443/', allowUntrustedCertificate: true },
    { url: 'https://a0.example.com:8443/other', allowUntrustedCertificate: true },
    { url: 'https://not-opted-in.example.com/', allowUntrustedCertificate: false },
    { url: 'https://missing-flag.example.com/' },
    { url: 'http://plain-http.example.com/', allowUntrustedCertificate: true },
    { url: 'not a url', allowUntrustedCertificate: true },
    null,
    'not an object'
  ]);
  assert.deepEqual([...hosts], ['a0.example.com']);
  assert.equal(trustedHostsFromRemoteInstances(undefined).size, 0);
});

test('a certificate fits a host by a subject alternative name, inside its validity window', () => {
  assert.equal(certificateFitsHost(CERT, 'a0.example.com', INSIDE), true);
  assert.equal(certificateFitsHost(CERT, 'A0.EXAMPLE.COM.', INSIDE), true);
  assert.equal(certificateFitsHost(CERT, '10.0.0.5', INSIDE), true);
  assert.equal(certificateFitsHost(CERT, 'evil.example.com', INSIDE), false);
  assert.equal(certificateFitsHost(CERT, 'sub.a0.example.com', INSIDE), false);
  assert.equal(certificateFitsHost(CERT, '10.0.0.6', INSIDE), false);
  assert.equal(certificateFitsHost(CERT, 'a0.example.com', BEFORE), false);
  assert.equal(certificateFitsHost(CERT, 'a0.example.com', AFTER), false);
  assert.equal(certificateFitsHost(null, 'a0.example.com', INSIDE), false);
});

test('names are matched as browsers match them', () => {
  // A subject CN without SAN is not enough.
  assert.equal(certificateFitsHost(new X509Certificate(CN_ONLY_PEM), 'a0.example.com', INSIDE), false);
  // Partial wildcards do not match.
  assert.equal(certificateFitsHost(new X509Certificate(PARTIAL_WILDCARD_PEM), 'a0x.example.com', INSIDE), false);
});

test('the Chromium verifier accepts an unknown issuer on a trusted host with a fitting certificate', () => {
  assert.equal(verdict(request()), CERTIFICATE_ACCEPT);
  assert.equal(verdict(request({ hostname: '10.0.0.5' })), CERTIFICATE_ACCEPT);
});

test('the Chromium verifier keeps Chromium\'s verdict in every other case', () => {
  const chromium = CERTIFICATE_USE_CHROMIUM_RESULT;
  // Chromium already trusts it.
  assert.equal(verdict(request({ errorCode: 0 })), chromium);
  // Other certificate errors are never forgiven.
  assert.equal(verdict(request({ errorCode: -200 })), chromium);
  assert.equal(verdict(request({ errorCode: -201 })), chromium);
  // The host did not opt in.
  assert.equal(verdict(request(), optedIn('other.example.com')), chromium);
  assert.equal(verdict(request(), []), chromium);
  // "Unknown issuer" hides a wrong name and an expired date: both still refused.
  assert.equal(verdict(request({ hostname: 'evil.example.com' }), optedIn('evil.example.com')), chromium);
  assert.equal(verdict(request(), undefined, AFTER), chromium);
  // Nothing usable to check.
  assert.equal(verdict(request({ certificate: { data: 'not a certificate' } })), chromium);
  assert.equal(verdict(request({ certificate: undefined })), chromium);
  assert.equal(verdict(undefined), chromium);
});

test('a failure while deciding keeps Chromium\'s verdict and still answers once', () => {
  const trust = createCertificateTrust({ now: () => { throw new Error('boom'); } });
  trust.update(optedIn('a0.example.com'));
  assert.equal(check(trust, request()), CERTIFICATE_USE_CHROMIUM_RESULT);
});

test('a changed opt-in needs a restart only when Chromium has cached a verdict that hangs on it', () => {
  const url = 'https://a0.example.com:5443/';
  const trust = createCertificateTrust({ now: () => INSIDE });

  // Nothing checked yet in this run: the change applies at once.
  trust.update(optedIn('a0.example.com'));
  assert.equal(trust.restartRequired(url), false);

  // Refused while not opted in, then opted in: the cached refusal stays.
  trust.update([]);
  assert.equal(check(trust, request()), CERTIFICATE_USE_CHROMIUM_RESULT);
  trust.update(optedIn('a0.example.com'));
  assert.equal(trust.restartRequired(url), true);
  // Another port of the same host shares the verdict.
  assert.equal(trust.restartRequired('https://a0.example.com:8443/'), true);
  // Back to the opt-in the verdict was made with: nothing to apply.
  trust.update([]);
  assert.equal(trust.restartRequired(url), false);

  // Accepted while opted in, then opted out: the cached acceptance stays.
  trust.update(optedIn('a0.example.com'));
  assert.equal(check(trust, request()), CERTIFICATE_ACCEPT);
  trust.update([]);
  assert.equal(trust.restartRequired(url), true);
  assert.equal(trust.restartRequired('http://a0.example.com/'), false);
});

test('verdicts that do not hang on the opt-in never ask for a restart', () => {
  const trust = createCertificateTrust({ now: () => INSIDE });
  // A certificate Chromium trusts anyway, and one that does not fit the host.
  check(trust, request({ errorCode: 0 }));
  check(trust, request({ hostname: 'evil.example.com' }));
  check(trust, request({ errorCode: -201 }));
  trust.update(optedIn('a0.example.com', 'evil.example.com'));
  assert.equal(trust.restartRequired('https://a0.example.com/'), false);
  assert.equal(trust.restartRequired('https://evil.example.com/'), false);
});

test('a node:https socket is judged by the same rule', () => {
  // A certificate Node already trusts.
  assert.equal(tlsSocketAcceptable(socket({ authorized: true, authorizationError: null }), 'anything', INSIDE), true);
  // Unknown issuer, fitting certificate.
  assert.equal(tlsSocketAcceptable(socket(), 'a0.example.com', INSIDE), true);
  assert.equal(tlsSocketAcceptable(socket({ authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), 'a0.example.com', INSIDE), true);
  // Unknown issuer, but the certificate does not fit.
  assert.equal(tlsSocketAcceptable(socket(), 'evil.example.com', INSIDE), false);
  assert.equal(tlsSocketAcceptable(socket(), 'a0.example.com', AFTER), false);
  // Other errors are never forgiven.
  assert.equal(tlsSocketAcceptable(socket({ authorizationError: 'CERT_HAS_EXPIRED' }), 'a0.example.com', INSIDE), false);
  assert.equal(tlsSocketAcceptable(socket({ authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'a0.example.com', INSIDE), false);
  // Nothing usable to check.
  assert.equal(tlsSocketAcceptable(socket({ getPeerX509Certificate: undefined }), 'a0.example.com', INSIDE), false);
  assert.equal(tlsSocketAcceptable(undefined, 'a0.example.com', INSIDE), false);
});
