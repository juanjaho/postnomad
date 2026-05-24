/**
 * Postnomad — OS trust-store install for the local CA.
 *
 * Phase 4d of the Proxyman roadmap. Installing the Postnomad CA into
 * the OS trust store is what makes HTTPS captures Just Work in
 * browsers / apps without per-process `--ca` flags.
 *
 * Security context (read before extending):
 *   Anyone with read access to the CA private key in
 *   <userData>/postnomad-ca/postnomad-ca.key can MITM ANY TLS
 *   connection on this machine until the CA is removed from trust.
 *   That's why this module:
 *     - REQUIRES the user to authenticate (admin prompt) for both
 *       install and uninstall
 *     - Stages the CA cert in a fresh mkdtemp directory before
 *       running the elevated command — so the path is well-known to
 *       us and can't be substituted between staging and execution
 *     - Quotes paths defensively even though they should be tame
 *
 * Platform support today:
 *   - macOS: full install/uninstall/check via `security` + osascript
 *   - Windows: install/uninstall/check via certutil — elevation TODO
 *   - Linux: install/uninstall via update-ca-certificates — pkexec/sudo TODO
 *
 * Cross-platform: not all browsers honour the system trust store
 * uniformly. Firefox uses its own NSS store on every OS; Chrome on
 * Linux uses NSS too. We document this but don't try to install into
 * Firefox programmatically — too many failure modes.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execAsync = promisify(exec);

const CA_FRIENDLY_NAME = 'Postnomad Local CA';

const shellEscape = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Stage the CA cert in a fresh per-call tmp directory so the file path
 * we hand to the elevated command can't be swapped under us.
 */
const stageCa = (sourcePath) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postnomad-trust-'));
  const dest = path.join(dir, 'postnomad-ca.crt');
  fs.copyFileSync(sourcePath, dest);
  return { dir, path: dest };
};

const cleanupStaged = (staged) => {
  try {
    if (staged && staged.dir && fs.existsSync(staged.dir)) {
      fs.rmSync(staged.dir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
};

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

const macSystemKeychain = '/Library/Keychains/System.keychain';

const macInstall = async (caCertPath) => {
  const staged = stageCa(caCertPath);
  try {
    const inner = `security add-trusted-cert -d -r trustRoot -k ${shellEscape(macSystemKeychain)} ${shellEscape(staged.path)}`;
    const osa = `do shell script "${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
    await execAsync(`osascript -e ${shellEscape(osa)}`);
  } finally {
    cleanupStaged(staged);
  }
};

const macUninstall = async () => {
  // delete-certificate by friendly name from the System keychain.
  // Returns non-zero if the cert isn't there; we swallow that case so
  // calling uninstall when not installed is idempotent.
  const inner = `security delete-certificate -c ${shellEscape(CA_FRIENDLY_NAME)} ${shellEscape(macSystemKeychain)}`;
  const osa = `do shell script "${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
  try {
    await execAsync(`osascript -e ${shellEscape(osa)}`);
  } catch (err) {
    if (!/SecKeychainSearch/i.test(String(err.stderr || err.message))) {
      throw err;
    }
  }
};

const macIsInstalled = async () => {
  try {
    await execAsync(`security find-certificate -c ${shellEscape(CA_FRIENDLY_NAME)} ${shellEscape(macSystemKeychain)}`);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Windows (best-effort; UAC handling lives in caller for now)
// ---------------------------------------------------------------------------

const winInstall = async (caCertPath) => {
  // certutil -addstore -f ROOT <path> needs admin. Caller is expected
  // to elevate; future work: spawn via PowerShell Start-Process -Verb RunAs.
  await execAsync(`certutil -addstore -f "ROOT" "${caCertPath}"`);
};

const winUninstall = async () => {
  try {
    await execAsync(`certutil -delstore "ROOT" "${CA_FRIENDLY_NAME}"`);
  } catch {
    // idempotent
  }
};

const winIsInstalled = async () => {
  try {
    await execAsync(`certutil -store "ROOT" "${CA_FRIENDLY_NAME}"`);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Linux (Debian/Ubuntu/RHEL-ish via update-ca-certificates; needs sudo/pkexec)
// ---------------------------------------------------------------------------

const linuxCaPath = '/usr/local/share/ca-certificates/postnomad.crt';

const linuxInstall = async (caCertPath) => {
  // Try pkexec first (modern GUI auth); fall back to sudo. Both will
  // fail without an authentication helper in non-interactive terminals.
  const installCmd = `cp ${shellEscape(caCertPath)} ${shellEscape(linuxCaPath)} && update-ca-certificates`;
  try {
    await execAsync(`pkexec sh -c ${shellEscape(installCmd)}`);
  } catch {
    await execAsync(`sudo sh -c ${shellEscape(installCmd)}`);
  }
};

const linuxUninstall = async () => {
  const uninstallCmd = `rm -f ${shellEscape(linuxCaPath)} && update-ca-certificates --fresh`;
  try {
    await execAsync(`pkexec sh -c ${shellEscape(uninstallCmd)}`);
  } catch {
    await execAsync(`sudo sh -c ${shellEscape(uninstallCmd)}`);
  }
};

const linuxIsInstalled = async () => fs.existsSync(linuxCaPath);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const platformImpl = () => {
  switch (process.platform) {
    case 'darwin':
      return { install: macInstall, uninstall: macUninstall, isInstalled: macIsInstalled };
    case 'win32':
      return { install: winInstall, uninstall: winUninstall, isInstalled: winIsInstalled };
    case 'linux':
      return { install: linuxInstall, uninstall: linuxUninstall, isInstalled: linuxIsInstalled };
    default:
      return {
        install: async () => {
          throw new Error('Unsupported platform: ' + process.platform);
        },
        uninstall: async () => {
          throw new Error('Unsupported platform: ' + process.platform);
        },
        isInstalled: async () => false
      };
  }
};

const installCaInSystemTrust = async (caCertPath) => {
  if (!caCertPath || !fs.existsSync(caCertPath)) {
    throw new Error('CA cert path missing or not present on disk: ' + caCertPath);
  }
  await platformImpl().install(caCertPath);
};

const uninstallCaFromSystemTrust = async () => {
  await platformImpl().uninstall();
};

const isCaInSystemTrust = async () => {
  try {
    return await platformImpl().isInstalled();
  } catch {
    return false;
  }
};

module.exports = {
  installCaInSystemTrust,
  uninstallCaFromSystemTrust,
  isCaInSystemTrust,
  CA_FRIENDLY_NAME,
  // For tests:
  _internal: { shellEscape, stageCa, cleanupStaged }
};
