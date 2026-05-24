/**
 * IPC bridge for the Postnomad capture proxy (Phase 3 of the Proxyman
 * roadmap). The renderer drives a singleton CaptureServer instance via
 * these handlers; the server pushes capture events back over the
 * `main:capture-event` channel.
 *
 * Channels:
 *   - renderer:capture-start { port? }        -> { port } | error
 *   - renderer:capture-stop                    -> { stopped: true }
 *   - renderer:capture-status                  -> { running, port }
 *   - main:capture-event (server -> renderer)  emitted per request/response pair
 */

const { ipcMain } = require('electron');
const { CaptureServer } = require('../proxy/captureServer');

const DEFAULT_CAPTURE_PORT = 9999;

const registerCaptureIpc = (mainWindow) => {
  const server = new CaptureServer();

  const onCapture = (event) => {
    // Renderer may be torn down before we get here (window close races).
    if (!mainWindow || mainWindow.isDestroyed?.()) return;
    try {
      mainWindow.webContents.send('main:capture-event', event);
    } catch {
      // Swallow IPC errors — capture should never crash the main process.
    }
  };

  ipcMain.handle('renderer:capture-start', async (_event, opts = {}) => {
    if (server.isRunning()) {
      return { port: server.port, alreadyRunning: true };
    }
    const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : DEFAULT_CAPTURE_PORT;
    try {
      const result = await server.start({ port, onCapture });
      return { port: result.port };
    } catch (err) {
      // EADDRINUSE is the typical case — surface a clean error to the renderer.
      throw new Error('Could not start capture proxy on port ' + port + ': ' + err.message);
    }
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

  // Make sure the proxy is shut down when the window goes away.
  if (mainWindow && mainWindow.on) {
    mainWindow.on('closed', () => {
      server.stop().catch(() => {});
    });
  }
};

module.exports = registerCaptureIpc;
module.exports.DEFAULT_CAPTURE_PORT = DEFAULT_CAPTURE_PORT;
