/**
 * Postnomad — local CA for the HTTPS-intercepting capture proxy.
 *
 * Phase 4a of the Proxyman roadmap. Generates a Postnomad-local
 * Certificate Authority once per install, persists it under userData,
 * and mints short-lived per-host leaf certificates on demand. The CA
 * is what the user installs into their OS trust store; the leaf certs
 * are never seen by humans — they're used by the proxy's TLS
 * terminator to impersonate origins so we can read decrypted traffic.
 *
 * IMPORTANT security note: anyone with read access to the userData
 * directory can extract the CA private key and use it to MITM ANY
 * TLS connection on the user's machine. The trust-install flow in
 * a later sub-phase must warn the user about this and refuse to
 * install if userData isn't on local disk (e.g., synced to iCloud /
 * Dropbox / a network share).
 *
 * Per-host leaf cert keys are NOT persisted — they live in an
 * in-memory LRU keyed by host. Restarting the proxy mints fresh leaves
 * (the CA is the only thing the OS trusts; leaf identity doesn't
 * matter as long as the chain is valid).
 */

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { createHash } = require('crypto');

const CA_FILE = 'postnomad-ca.crt';
const CA_KEY_FILE = 'postnomad-ca.key';
const CA_VALIDITY_YEARS = 3;
const LEAF_VALIDITY_DAYS = 365;
const RSA_KEY_BITS = 2048;
const LEAF_CACHE_MAX = 256;

const buildCaSubject = (organizationName) => [
  { name: 'commonName', value: `${organizationName} Local CA` },
  { name: 'organizationName', value: organizationName },
  { name: 'organizationalUnitName', value: 'HTTPS Capture' },
  { name: 'countryName', value: 'US' }
];

const buildLeafSubject = (host, organizationName) => [
  { name: 'commonName', value: host },
  { name: 'organizationName', value: `${organizationName} MITM` }
];

const isIpAddress = (host) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$|:/.test(host);

class CertificateAuthority {
  constructor({ storageDir, organizationName = 'Postnomad' } = {}) {
    if (!storageDir) throw new Error('CertificateAuthority requires storageDir');
    this.storageDir = storageDir;
    this.organizationName = organizationName;
    this.caCert = null; // forge.pki.Certificate
    this.caKey = null; // forge.pki.PrivateKey
    this.leafKey = null; // single RSA keypair reused across all leaf certs (matches mitmproxy)
    this.leafCache = new Map(); // host -> { certPem, keyPem }
  }

  get caCrtPath() {
    return path.join(this.storageDir, CA_FILE);
  }

  get caKeyPath() {
    return path.join(this.storageDir, CA_KEY_FILE);
  }

  /**
   * Load the CA from disk if present, otherwise mint a fresh one and
   * persist it. Idempotent — calling twice is a no-op after the first call.
   */
  async ensureCa() {
    if (this.caCert && this.caKey) return;

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    if (fs.existsSync(this.caCrtPath) && fs.existsSync(this.caKeyPath)) {
      const certPem = fs.readFileSync(this.caCrtPath, 'utf8');
      const keyPem = fs.readFileSync(this.caKeyPath, 'utf8');
      this.caCert = forge.pki.certificateFromPem(certPem);
      this.caKey = forge.pki.privateKeyFromPem(keyPem);
      return;
    }

    const { cert, key } = this._mintCa();
    fs.writeFileSync(this.caCrtPath, forge.pki.certificateToPem(cert), { mode: 0o600 });
    fs.writeFileSync(this.caKeyPath, forge.pki.privateKeyToPem(key), { mode: 0o600 });
    this.caCert = cert;
    this.caKey = key;
  }

  _mintCa() {
    const keys = forge.pki.rsa.generateKeyPair(RSA_KEY_BITS);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CA_VALIDITY_YEARS);
    const subject = buildCaSubject(this.organizationName);
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        critical: true,
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true
      },
      { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { cert, key: keys.privateKey };
  }

  _ensureLeafKey() {
    if (this.leafKey) return this.leafKey;
    this.leafKey = forge.pki.rsa.generateKeyPair(RSA_KEY_BITS);
    return this.leafKey;
  }

  /**
   * Returns { certPem, keyPem } for the given host. Mints lazily,
   * caches in memory (LRU of size LEAF_CACHE_MAX).
   */
  mintCertForHost(host) {
    if (!this.caCert || !this.caKey) {
      throw new Error('CA not initialized — call ensureCa() first');
    }
    if (!host || typeof host !== 'string') {
      throw new Error('mintCertForHost requires a host string');
    }
    const cached = this.leafCache.get(host);
    if (cached) {
      // LRU bump
      this.leafCache.delete(host);
      this.leafCache.set(host, cached);
      return cached;
    }

    const keys = this._ensureLeafKey();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + LEAF_VALIDITY_DAYS);
    cert.setSubject(buildLeafSubject(host, this.organizationName));
    cert.setIssuer(this.caCert.subject.attributes);

    const altNames = [];
    if (isIpAddress(host)) {
      altNames.push({ type: 7, ip: host }); // iPAddress
    } else {
      altNames.push({ type: 2, value: host }); // dNSName
    }
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        critical: true,
        digitalSignature: true,
        keyEncipherment: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true
      },
      { name: 'subjectAltName', altNames },
      { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    const entry = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey)
    };
    this.leafCache.set(host, entry);
    if (this.leafCache.size > LEAF_CACHE_MAX) {
      // Evict oldest (Map keeps insertion order).
      const firstKey = this.leafCache.keys().next().value;
      this.leafCache.delete(firstKey);
    }
    return entry;
  }

  /**
   * The CA's certificate as a PEM string — what the user installs into
   * their OS trust store.
   */
  getCaCertPem() {
    if (!this.caCert) return null;
    return forge.pki.certificateToPem(this.caCert);
  }

  /**
   * Human/UI-friendly metadata about the CA. The fingerprint is the
   * SHA-256 of the DER-encoded cert, which is what tools like `openssl`
   * and the macOS Keychain show.
   */
  getCaInfo() {
    if (!this.caCert) return null;
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes();
    const fingerprint = createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
    return {
      organization: this.organizationName,
      subjectCommonName: this.caCert.subject.getField('CN')?.value,
      validFrom: this.caCert.validity.notBefore.toISOString(),
      validTo: this.caCert.validity.notAfter.toISOString(),
      fingerprintSha256: fingerprint,
      caCrtPath: this.caCrtPath
    };
  }

  /**
   * Wipe persisted CA + clear all caches. Forces re-mint on next
   * ensureCa(). Used by the UI's "regenerate CA" flow — the user will
   * need to re-install the new CA into their trust store, but it's the
   * right move if they suspect the old CA leaked.
   */
  async forgetAndRegenerate() {
    this.caCert = null;
    this.caKey = null;
    this.leafKey = null;
    this.leafCache.clear();
    for (const p of [this.caCrtPath, this.caKeyPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await this.ensureCa();
  }
}

// 20-byte positive integer serial, hex-encoded — RFC 5280 caps at 20 bytes.
function randomSerial() {
  const bytes = forge.random.getBytesSync(20);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += ('0' + bytes.charCodeAt(i).toString(16)).slice(-2);
  }
  // Strip leading bit so it stays positive (X.509 serials are signed integers).
  // hex[0] is a 4-bit nibble — mask 0x7 keeps the top bit clear (values 0-7).
  return ((parseInt(hex[0], 16) & 0x7).toString(16) + hex.slice(1)).slice(0, 40);
}

module.exports = { CertificateAuthority, _internal: { randomSerial, isIpAddress } };
