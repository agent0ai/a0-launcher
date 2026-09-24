const assert = require('node:assert/strict');
const https = require('node:https');
const { test } = require('node:test');

const { requestInstanceHealth } = require('./index')._test;

// Test-only self-signed server certificate. Its only SAN is IP 127.0.0.1, so
// "localhost" is a name it does not carry. Valid for 100 years from 2026-09-24.
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDDMcjlTvfF7a2J
NnOqSQ/ryricsMgYddnZU4zr9+/tfiKN/Y51mnQBQPyUC50E7Z/GvyeINnxhb0l3
372sIVKDv7Z/m9xZ4lQAHXHLGfCfBYR3ucT+d/rwR1aBgT5ZoYwq7N+RVwGskvll
kDBZIorfosREcdpeEMbmmTNSm87ab9owdjYxLFibcrOivMKewHzY4rpjsBVGgYCj
sYg/vT6CiBgkFvs3LlTIq4vaAcyzpkx22vqy3rKNfh7sEYmq1xL7LS/tt1Gf8r3k
n38XNxvqQkYzs5ki1GnOnKgV/nyA9uumKHLeWP4/wdrdIPDASl3vjKILOeMVOTyb
CqB/RS4hAgMBAAECggEAAm7dJpvU6YKHdgMr5tu0WUGqmoAm/dxP9OIyYrV5b/0B
S3KdcUKFozd9EH+6r0tSmU+0G4nlk/G3FVGYfcAQdSZFVS7PRM7uEe5sBvp7xAEt
sg/6lEsQwYiLm9eVfEi34Hf5d1Bpu8XdGkilXCKSv2PyGSnvxUn1bz3aEJPC7MjI
IEotyg3a3x3qrtFPtbQZSSsr13cdYpqRCu/HpShhO4Ostw+gLjXPSTZlHCKaCDwc
47Xz0o+HoDcfS2LZXghqgHXKbGyavVwgYzRo60xuSIOsz/OJshUNU+5Kw0UU5D70
f/BGoF9IvIZVbjuAnyMMTxyIOJzN7Yb2wpf5SB7gAQKBgQDomzL3wwulVzOhRJkK
wcxO9wgHHsJiLpY4XhfF2x0uVtSmdGpCbRBnOf79kLE+z6rcJKlcmsgqRIGz9Isl
BZiJ1HsGPWdyhkpZPhqdzftaSNmQXgNvIuJ82DYMeIEQ/vJzWgqDjzBi1j1VfMWL
c7+YQC5qLB+G0nVfs4J36/nOIQKBgQDW01zbd41qo/EagDibpQlp9QXf5H2OrFQF
oRMFRQ3vteZu4U6I8/SzT6XnOihDH3f6JRjwPmzUOM75nBngFar0F0IyPT6nJOco
WUu86v41+DA/uuv2m3+cNuO90o7ooQByQkvYA50cOyUrmjc6DGS2uuKutrfebwtD
GK2s8B9gAQKBgQDi3uUCVQHZ3UilRZQDsuwEJNt2nmC3hHrONa/4MfOvS8+THr65
VUkHdcCoLmVCPyiGGVf605jh6PmcvKqujFuwK0dm2aM5R5PioTkyq0I6WA2jyp6M
2jiPzg5BcZNpMVDmg273zEREUnN2GwFON7Iq3Iao1apWRJVop1xcfROkIQKBgFT1
7LCDfLNjORSRB1JPGAUGuZcNp7aIYwaC6KHZ6KQYHZVWmBfD29AavPNQ5eF+DZYp
m85P8fyQpxLC8NzV1PGKTUzPOfsitiUYA8MocPdpO7PIuk+iufpPHwzQvGI2YpXN
sG8zJqymm5G+AP99LUuzZ7lPXDKlWh/kH7PYl6ABAoGBAM4lRzuVxdfJiOYXYvS4
5JWYG5tkkoXiUwh+UNGLCoEFSxZAd4NOc3jEL9F0Yq3ud6H+wFRd5hCK7pMNUMbu
6nxfQc3POdow6xMQNncIa3txp4+MoVNEqmudZj19FGchrH1zCJSL1QTxEnrvB1ip
qrzxJiF3D+lyIbR3oqfiKntY
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIUHbZlY7aQZXcwxNLOo1Z2+1xrMk0wDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKcHJvYmUtdGVzdDAgFw0yNjA5MjQwMTQ0NTVaGA8yMTI2
MDgzMTAxNDQ1NVowFTETMBEGA1UEAwwKcHJvYmUtdGVzdDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAMMxyOVO98XtrYk2c6pJD+vKuJywyBh12dlTjOv3
7+1+Io39jnWadAFA/JQLnQTtn8a/J4g2fGFvSXffvawhUoO/tn+b3FniVAAdccsZ
8J8FhHe5xP53+vBHVoGBPlmhjCrs35FXAayS+WWQMFkiit+ixERx2l4QxuaZM1Kb
ztpv2jB2NjEsWJtys6K8wp7AfNjiumOwFUaBgKOxiD+9PoKIGCQW+zcuVMiri9oB
zLOmTHba+rLeso1+HuwRiarXEvstL+23UZ/yveSffxc3G+pCRjOzmSLUac6cqBX+
fID266Yoct5Y/j/B2t0g8MBKXe+Mogs54xU5PJsKoH9FLiECAwEAAaNkMGIwHQYD
VR0OBBYEFKfEVHUf8c86qWIpHoASovkNQF+4MB8GA1UdIwQYMBaAFKfEVHUf8c86
qWIpHoASovkNQF+4MA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEfwAAATAN
BgkqhkiG9w0BAQsFAAOCAQEAq6dMd0r/ikac6CnuWb7+epAoFTA31v+vLqkhTqr7
w0/TXwrOdOWa6aZA929DiZe5EiSzIEcbhj1wpFAi4arIdIiRcBRLsmV4q7pVbW/T
Qgj2IK26SnGLpSW976Dp4LfzDgqvNuVaAgL7H9/dYkc5n4qdjAt7Ppb5waT/FBek
WmBW5og+7hD8PM/SXLqS/RnWLfW5LVl4yKIqj1AQBAdHXn9oH2K5x7x9w8PTKrwg
5giKlWRl5aaFEpnxnUydkPrng8IS0GAoEXW4iGIIeyyoBNUNZRscNGlWnx7H68x8
wW0wZgmvBfT4zyzYabSci8cwTDeH4V3zr5TbD5IvPR7AnQ==
-----END CERTIFICATE-----`;

async function withHttpsServer(run) {
  const server = https.createServer({ key: KEY, cert: CERT }, (_req, res) => res.end('{}'));
  await new Promise((resolve) => server.listen(0, '::', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('without the opt-in the probe keeps rejecting an untrusted certificate', async () => {
  await withHttpsServer(async (port) => {
    const result = await requestInstanceHealth(`https://127.0.0.1:${port}/api/health`, 2000);
    assert.equal(result.online, false);
    assert.equal(result.error, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  });
});

test('with the opt-in the probe accepts an unknown issuer when the certificate names the host', async () => {
  await withHttpsServer(async (port) => {
    const result = await requestInstanceHealth(`https://127.0.0.1:${port}/api/health`, 2000, { trustCertificate: true });
    assert.equal(result.online, true);
    assert.equal(result.statusCode, 200);
  });
});

test('with the opt-in the probe still refuses a certificate for another name', async () => {
  await withHttpsServer(async (port) => {
    const result = await requestInstanceHealth(`https://localhost:${port}/api/health`, 2000, { trustCertificate: true });
    assert.deepEqual(result, { online: false, error: 'Certificate not accepted' });
  });
});

test('with the opt-in, repeated probes stay online', async () => {
  await withHttpsServer(async (port) => {
    const url = `https://127.0.0.1:${port}/api/health`;
    for (let i = 0; i < 3; i++) {
      const result = await requestInstanceHealth(url, 2000, { trustCertificate: true });
      assert.equal(result.online, true, `probe ${i + 1}: ${result.error || ''}`);
    }
  });
});
