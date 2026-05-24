/**
 * Postnomad HTTP capture server.
 *
 * Phase 3 of the Proxyman roadmap. Listens on a configurable port and acts as
 * a forward HTTP proxy: incoming clients (browser / curl / system proxy)
 * send absolute-URL requests, this server forwards them to the upstream
 * origin, and every request/response pair is emitted to the registered
 * onCapture callback for the renderer to display in a live capture pane.
 *
 * Scope (intentionally minimal — Phase 3 covers HTTP only):
 *   - Plaintext HTTP forward proxy. CONNECT (HTTPS tunneling) is refused with
 *     a 501; HTTPS interception comes in Phase 4 with the minted-CA work.
 *   - Captures method / URL / headers / body for both request and response.
 *   - Best-effort gzip/deflate/br decoding for the captured response body so
 *     the UI doesn't show binary garbage. The bytes sent back to the client
 *     are NOT touched — pass-through is byte-perfect.
 *   - Hop-by-hop headers (RFC 7230 §6.1) are stripped on forward.
 *
 * The module exports a class so tests can stand up an isolated server
 * without colliding with the IPC singleton.
 */

const http = require('http');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const zlib = require('zlib');

// RFC 7230 §6.1 hop-by-hop headers — must not be forwarded by a proxy.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
]);

const MAX_CAPTURED_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap per body in the capture record

const stripHopByHopHeaders = (headers) => {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      out[name] = value;
    }
  }
  return out;
};

const decodeBodyForDisplay = (buffer, contentEncoding) => {
  if (!contentEncoding) return buffer;
  const enc = String(contentEncoding).toLowerCase().trim();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // Fall through to raw bytes on decode failure.
  }
  return buffer;
};

const bufferToDisplayString = (buffer, contentType) => {
  if (!buffer || buffer.length === 0) return '';
  const looksTextual =
    !contentType ||
    /^text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|\+(json|xml)/i.test(contentType);
  if (!looksTextual) {
    return `[binary ${buffer.length} bytes]`;
  }
  return buffer.toString('utf8');
};

class CaptureServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.onCapture = null;
    this.captureCount = 0;
  }

  /**
   * Start the proxy listening on `port` (0 = auto-assign). `onCapture` is
   * called twice per request: once when the request is fully received
   * (response field null), once when the response is complete (response
   * populated). Errors during forwarding produce a single capture event
   * with `response.error` set.
   */
  async start({ port = 0, onCapture } = {}) {
    if (this.server) {
      throw new Error('CaptureServer already running on port ' + this.port);
    }
    this.onCapture = typeof onCapture === 'function' ? onCapture : null;

    this.server = http.createServer((req, res) => this._handle(req, res));

    this.server.on('connect', (req, clientSocket) => {
      // HTTPS tunnel — not supported in Phase 3.
      clientSocket.write(
        'HTTP/1.1 501 Not Implemented\r\n' +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'Postnomad HTTP capture does not support HTTPS tunneling yet (Phase 4).\n' +
          'Connect over plain HTTP, or wait for the minted-CA TLS interception.\n'
      );
      clientSocket.end();
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        this.server = null;
        reject(err);
      });
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve({ port: this.port });
      });
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    this.onCapture = null;
    await new Promise((resolve) => server.close(resolve));
  }

  isRunning() {
    return !!this.server;
  }

  _emit(event) {
    if (this.onCapture) {
      try {
        this.onCapture(event);
      } catch {
        // Don't let renderer-side errors crash the proxy.
      }
    }
  }

  _handle(req, res) {
    const captureId = randomUUID();
    this.captureCount += 1;
    const startedAt = Date.now();

    // The request URL is absolute when speaking to a forward proxy; if not,
    // we can't tell where to forward it.
    let targetUrl;
    try {
      targetUrl = new URL(req.url);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(
        'Postnomad capture proxy needs absolute URLs (e.g. configure your ' +
          'system or app to use 127.0.0.1:' +
          this.port +
          ' as an HTTP proxy).\n'
      );
      return;
    }

    if (targetUrl.protocol !== 'http:') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Postnomad capture (Phase 3) only forwards http://. ' + targetUrl.protocol + ' will land in Phase 4.\n');
      return;
    }

    const reqHeaders = stripHopByHopHeaders(req.headers);

    const reqChunks = [];
    let reqByteCount = 0;
    req.on('data', (chunk) => {
      reqByteCount += chunk.length;
      if (reqByteCount <= MAX_CAPTURED_BODY_BYTES) {
        reqChunks.push(chunk);
      }
    });

    req.on('end', () => {
      const requestBuffer = Buffer.concat(reqChunks);
      const requestRecord = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: bufferToDisplayString(requestBuffer, req.headers['content-type']),
        bodyBytes: reqByteCount
      };

      // Emit a "request seen" event before we even hit the upstream.
      this._emit({
        id: captureId,
        phase: 'request',
        timestamp: startedAt,
        request: requestRecord,
        response: null
      });

      const upstream = http.request(
        {
          host: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers: reqHeaders
        },
        (upstreamRes) => {
          const respChunks = [];
          let respByteCount = 0;
          upstreamRes.on('data', (chunk) => {
            respByteCount += chunk.length;
            // Tee: forward to client AND buffer for capture (capped).
            res.write(chunk);
            if (respByteCount <= MAX_CAPTURED_BODY_BYTES) {
              respChunks.push(chunk);
            }
          });
          upstreamRes.on('end', () => {
            res.end();
            const rawBuffer = Buffer.concat(respChunks);
            const decoded = decodeBodyForDisplay(rawBuffer, upstreamRes.headers['content-encoding']);
            const responseRecord = {
              status: upstreamRes.statusCode,
              statusText: upstreamRes.statusMessage,
              headers: { ...upstreamRes.headers },
              body: bufferToDisplayString(decoded, upstreamRes.headers['content-type']),
              bodyBytes: respByteCount,
              durationMs: Date.now() - startedAt
            };
            this._emit({
              id: captureId,
              phase: 'response',
              timestamp: startedAt,
              request: requestRecord,
              response: responseRecord
            });
          });
          // Forward status + headers verbatim.
          res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.headers);
        }
      );

      upstream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Postnomad capture proxy upstream error: ' + err.message);
        } else {
          res.end();
        }
        this._emit({
          id: captureId,
          phase: 'response',
          timestamp: startedAt,
          request: requestRecord,
          response: {
            error: err.message,
            durationMs: Date.now() - startedAt
          }
        });
      });

      if (requestBuffer.length > 0) {
        upstream.write(requestBuffer);
      }
      upstream.end();
    });

    req.on('error', () => {
      // Client aborted before we got the full request — drop quietly.
    });
  }
}

module.exports = {
  CaptureServer,
  // Exported for tests:
  _internal: { stripHopByHopHeaders, decodeBodyForDisplay, bufferToDisplayString, HOP_BY_HOP_HEADERS }
};
