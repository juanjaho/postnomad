const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const https = require('https');
const forge = require('node-forge');
const { CertificateAuthority, _internal } = require('./ca');

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'postnomad-ca-test-'));

describe('CertificateAuthority — generation + persistence', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mints + persists a CA on first ensureCa', async () => {
    dir = mkTmp();
    const ca = new CertificateAuthority({ storageDir: dir });
    await ca.ensureCa();
    expect(fs.existsSync(path.join(dir, 'postnomad-ca.crt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'postnomad-ca.key'))).toBe(true);

    const pem = ca.getCaCertPem();
    const cert = forge.pki.certificateFromPem(pem);
    expect(cert.subject.getField('CN').value).toMatch(/Postnomad Local CA/);
    const bc = cert.extensions.find((e) => e.name === 'basicConstraints');
    expect(bc.cA).toBe(true);
  });

  it('reuses the persisted CA on second ensureCa (same fingerprint)', async () => {
    dir = mkTmp();
    const a = new CertificateAuthority({ storageDir: dir });
    await a.ensureCa();
    const fpA = a.getCaInfo().fingerprintSha256;

    const b = new CertificateAuthority({ storageDir: dir });
    await b.ensureCa();
    const fpB = b.getCaInfo().fingerprintSha256;

    expect(fpA).toBe(fpB);
  });

  it('forgetAndRegenerate produces a different CA', async () => {
    dir = mkTmp();
    const ca = new CertificateAuthority({ storageDir: dir });
    await ca.ensureCa();
    const before = ca.getCaInfo().fingerprintSha256;
    await ca.forgetAndRegenerate();
    const after = ca.getCaInfo().fingerprintSha256;
    expect(after).not.toBe(before);
  });

  it('exposes CA metadata (validity, fingerprint, paths)', async () => {
    dir = mkTmp();
    const ca = new CertificateAuthority({ storageDir: dir });
    await ca.ensureCa();
    const info = ca.getCaInfo();
    expect(info.organization).toBe('Postnomad');
    expect(info.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(info.validTo).getTime()).toBeGreaterThan(Date.now() + 1000 * 60 * 60 * 24 * 365);
    expect(info.caCrtPath).toContain('postnomad-ca.crt');
  });

  it('uses 0600 permissions on the CA key file', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits don't apply meaningfully on Windows
    dir = mkTmp();
    const ca = new CertificateAuthority({ storageDir: dir });
    await ca.ensureCa();
    const stat = fs.statSync(ca.caKeyPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('CertificateAuthority — leaf cert minting', () => {
  let dir;
  let ca;

  beforeEach(async () => {
    dir = mkTmp();
    ca = new CertificateAuthority({ storageDir: dir });
    await ca.ensureCa();
  });

  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mints a leaf signed by the CA with the host in SAN', () => {
    const { certPem } = ca.mintCertForHost('api.example.com');
    const cert = forge.pki.certificateFromPem(certPem);
    expect(cert.subject.getField('CN').value).toBe('api.example.com');
    const san = cert.extensions.find((e) => e.name === 'subjectAltName');
    expect(san).toBeTruthy();
    expect(san.altNames.find((a) => a.value === 'api.example.com')).toBeTruthy();

    // Verify the chain — CA signed the leaf.
    const caStore = forge.pki.createCaStore([ca.getCaCertPem()]);
    expect(forge.pki.verifyCertificateChain(caStore, [cert])).toBe(true);
  });

  it('caches per-host leaf certs (second mint returns the same PEM)', () => {
    const a = ca.mintCertForHost('cache.test');
    const b = ca.mintCertForHost('cache.test');
    expect(a.certPem).toBe(b.certPem);
    expect(a.keyPem).toBe(b.keyPem);
  });

  it('uses iPAddress SAN for IP-literal hosts', () => {
    const { certPem } = ca.mintCertForHost('127.0.0.1');
    const cert = forge.pki.certificateFromPem(certPem);
    const san = cert.extensions.find((e) => e.name === 'subjectAltName');
    // node-forge uses type 7 for IP, type 2 for dNSName.
    expect(san.altNames.some((a) => a.type === 7)).toBe(true);
  });

  it('throws if ensureCa was never called', () => {
    const fresh = new CertificateAuthority({ storageDir: mkTmp() });
    expect(() => fresh.mintCertForHost('whatever')).toThrow(/CA not initialized/);
  });

  it('serial numbers stay positive and unique across mints', () => {
    const a = forge.pki.certificateFromPem(ca.mintCertForHost('a.test').certPem);
    const b = forge.pki.certificateFromPem(ca.mintCertForHost('b.test').certPem);
    expect(a.serialNumber).not.toBe(b.serialNumber);
    // Leading bit cleared → first hex digit is 0-7.
    expect(a.serialNumber[0]).toMatch(/[0-7]/);
    expect(b.serialNumber[0]).toMatch(/[0-7]/);
  });
});

describe('CertificateAuthority — real TLS handshake using the minted leaf', () => {
  let dir;
  let ca;

  beforeEach(async () => {
    dir = mkTmp();
    ca = new CertificateAuthority({ storageDir: dir });
    await ca.ensureCa();
  });

  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stands up an HTTPS server with the minted cert and survives a real handshake against the CA', async () => {
    const { certPem, keyPem } = ca.mintCertForHost('localhost');
    const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello over real tls');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const body = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: '/',
          ca: ca.getCaCertPem(),
          // The cert's CN/SAN says "localhost", but we're connecting to
          // 127.0.0.1 — tell Node to validate against "localhost".
          servername: 'localhost'
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(body).toBe('hello over real tls');
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('CertificateAuthority — internals', () => {
  it('randomSerial returns hex strings <= 40 chars with leading-bit cleared', () => {
    for (let i = 0; i < 50; i++) {
      const s = _internal.randomSerial();
      expect(s).toMatch(/^[0-9a-f]+$/);
      expect(s.length).toBeLessThanOrEqual(40);
      expect(parseInt(s[0], 16) & 0x8).toBe(0);
    }
  });

  it('isIpAddress recognises IPv4 + colon-bearing IPv6, rejects DNS names', () => {
    expect(_internal.isIpAddress('127.0.0.1')).toBe(true);
    expect(_internal.isIpAddress('::1')).toBe(true);
    expect(_internal.isIpAddress('fe80::1')).toBe(true);
    expect(_internal.isIpAddress('example.com')).toBe(false);
    expect(_internal.isIpAddress('sub.example.io')).toBe(false);
  });
});
