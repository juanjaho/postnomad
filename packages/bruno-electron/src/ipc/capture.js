/**
 * IPC bridge for the Postnomad capture proxy (Phases 3+4 of the Proxyman
 * roadmap). The renderer drives a singleton CaptureServer instance via
 * these handlers; the server pushes capture events back over the
 * `main:capture-event` channel.
 *
 * In Phase 4 the server is wired with a Postnomad-local CA, so CONNECT
 * tunnels are intercepted, TLS is terminated with leaves minted on the
 * fly, and HTTPS captures land in the same event stream as plain HTTP.
 *
 * Channels:
 *   - renderer:capture-start { port? }        -> { port } | error
 *   - renderer:capture-stop                    -> { stopped: true }
 *   - renderer:capture-status                  -> { running, port, ca }
 *   - renderer:capture-ca-info                 -> { ca metadata + PEM }
 *   - renderer:capture-ca-regenerate          -> { ca metadata }
 *   - main:capture-event (server -> renderer)  emitted per request/response pair
 */

const path = require('path');
const { ipcMain, app } = require('electron');
const { CaptureServer } = require('../proxy/captureServer');
const { CertificateAuthority } = require('../proxy/ca');
const { installCaInSystemTrust, uninstallCaFromSystemTrust, isCaInSystemTrust } = require('../proxy/trust-install');

const DEFAULT_CAPTURE_PORT = 9999;

const registerCaptureIpc = (mainWindow) => {
  const server = new CaptureServer();
  // CA lives under userData/postnomad-ca/. Lazy — only mints on first use.
  const caStorageDir = path.join(app.getPath('userData'), 'postnomad-ca');
  const ca = new CertificateAuthority({ storageDir: caStorageDir });

  const onCapture = (event) => {
    // Renderer may be torn down before we get here (window close races).
    if (!mainWindow || mainWindow.isDestroyed?.()) return;
    try {
      mainWindow.webContents.send('main:capture-event', event);
    } catch {
      // Swallow IPC errors — capture should never crash the main process.
    }
  };

  // Phase 5b — fires when a request hits a breakpoint rule. The renderer
  // shows a modal; the user clicks Forward (optionally with edits) or
  // Cancel, and the corresponding renderer:capture-breakpoint-resolve
  // call wakes the held proxy promise.
  const onBreakpoint = (pause) => {
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      // Renderer's gone — auto-cancel so the client socket doesn't hang.
      server.resolveBreakpoint(pause.id, 'cancel');
      return;
    }
    try {
      mainWindow.webContents.send('main:capture-breakpoint', pause);
    } catch {
      server.resolveBreakpoint(pause.id, 'cancel');
    }
  };

  ipcMain.handle('renderer:capture-start', async (_event, opts = {}) => {
    if (server.isRunning()) {
      return { port: server.port, alreadyRunning: true };
    }
    const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : DEFAULT_CAPTURE_PORT;
    try {
      // Lazily mint/load the CA so first-run capture isn't penalised
      // by RSA generation if the user never triggers it.
      await ca.ensureCa();
      const result = await server.start({ port, onCapture, onBreakpoint, ca });
      return { port: result.port, caInfo: ca.getCaInfo() };
    } catch (err) {
      // EADDRINUSE is the typical case — surface a clean error to the renderer.
      throw new Error('Could not start capture proxy on port ' + port + ': ' + err.message);
    }
  });

  ipcMain.handle('renderer:capture-ca-info', async () => {
    await ca.ensureCa();
    return { ...ca.getCaInfo(), caCertPem: ca.getCaCertPem() };
  });

  ipcMain.handle('renderer:capture-ca-regenerate', async () => {
    await ca.forgetAndRegenerate();
    return { ...ca.getCaInfo(), caCertPem: ca.getCaCertPem() };
  });

  // Phase 4d — install/uninstall the CA into the OS trust store so HTTPS
  // capture works in browsers/apps without per-process trust overrides.
  //
  // Security note (echoed to the renderer too): once the CA is trusted,
  // anyone with read access to the userData directory can MITM any TLS
  // connection on the machine. Always pair this with the warning UI.
  ipcMain.handle('renderer:capture-ca-install-system-trust', async () => {
    await ca.ensureCa();
    await installCaInSystemTrust(ca.caCrtPath);
    return { installed: true };
  });

  ipcMain.handle('renderer:capture-ca-uninstall-system-trust', async () => {
    await uninstallCaFromSystemTrust();
    return { installed: false };
  });

  ipcMain.handle('renderer:capture-ca-system-trust-status', async () => {
    return { installed: await isCaInSystemTrust(), platform: process.platform };
  });

  ipcMain.handle('renderer:capture-stop', async () => {
    await server.stop();
    return { stopped: true };
  });

  ipcMain.handle('renderer:capture-status', async () => {
    return {
      running: server.isRunning(),
      port: server.port,
      captureCount: server.captureCount
    };
  });

  // Phase 5a — Rules engine. Renderer owns the source of truth (Redux
  // slice persisted to disk via the standard tasks middleware); on
  // change it pushes the full list down and the server replaces its
  // active set. Push always replaces — no diffs.
  ipcMain.handle('renderer:capture-set-rules', async (_event, rules) => {
    server.setRules(Array.isArray(rules) ? rules : []);
    return { count: server.rules.length };
  });

  // Phase 5b — renderer resolves a paused breakpoint.
  ipcMain.handle('renderer:capture-breakpoint-resolve', async (_event, payload = {}) => {
    const { id, action, edited } = payload;
    if (!id) return { resolved: false };
    return { resolved: server.resolveBreakpoint(id, action || 'cancel', edited) };
  });

  // Make sure the proxy is shut down when the window goes away.
  if (mainWindow && mainWindow.on) {
    mainWindow.on('closed', () => {
      server.stop().catch(() => {});
    });
  }
};

module.exports = registerCaptureIpc;
module.exports.DEFAULT_CAPTURE_PORT = DEFAULT_CAPTURE_PORT;
