/**
 * Postnomad HTTP/HTTPS capture server.
 *
 * Phases 3 + 4b/c of the Proxyman roadmap. Acts as a forward proxy:
 *   - For absolute http:// requests, forwards them directly (Phase 3).
 *   - For CONNECT host:443, if a CertificateAuthority is wired in,
 *     hijacks the socket, terminates TLS using a Postnomad-minted leaf
 *     cert for `host`, decrypts the inner HTTP, captures it, and
 *     re-encrypts on the outbound leg to the real origin (Phase 4b/c).
 *     Without a CA, CONNECT is refused with a 501.
 *
 * In both cases the capture pipeline (onCapture callback emitting
 * request/response phase events with id correlation) is the same —
 * the TLS interception is invisible to consumers.
 *
 * What we DON'T touch on the wire: the bytes flowing back to the
 * client are byte-perfect from the origin. The capture record decodes
 * gzip/deflate/br for display only.
 *
 * Limits:
 *   - 2 MB cap per captured body to bound memory.
 *   - Hop-by-hop headers (RFC 7230 §6.1) stripped on forward.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
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

const MAX_CAPTURED_BODY_BYTES = 2 * 1024 * 1024;

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

/**
 * Phase 5a rule matcher.
 *
 * A rule looks like:
 *   {
 *     id, enabled, name,
 *     matcher: { urlPattern: string, method: 'GET'|'POST'|...|'*' },
 *     action: 'mapLocal' | 'mapRemote',
 *     mapLocal?:  { filePath, statusCode = 200, contentType? },
 *     mapRemote?: { targetUrl }   // absolute, replaces scheme+host[+port]+path prefix
 *   }
 *
 * The urlPattern is a substring match against the absolute request URL
 * by default; if it starts AND ends with `/`, the content between the
 * slashes is treated as a regex. Cheap, predictable, no escape hatches
 * for users to shoot themselves in the foot.
 */
const matchesRule = (rule, method, absoluteUrl) => {
  if (!rule || rule.enabled === false) return false;
  const m = rule.matcher || {};
  if (m.method && m.method !== '*' && m.method.toUpperCase() !== (method || '').toUpperCase()) {
    return false;
  }
  const pattern = m.urlPattern || '';
  if (!pattern) return false;
  if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return re.test(absoluteUrl);
    } catch {
      return false;
    }
  }
  return absoluteUrl.includes(pattern);
};

const findMatchingRule = (rules, method, absoluteUrl) => {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (matchesRule(rule, method, absoluteUrl)) return rule;
  }
  return null;
};

class CaptureServer {
  constructor() {
    this.server = null;
    this.tlsServer = null;
    this.port = null;
    this.onCapture = null;
    this.ca = null;
    this.captureCount = 0;
    this.rules = []; // Phase 5: Map Local / Map Remote / (future) breakpoints
  }

  /**
   * Replace the active rule list. Called by the IPC layer whenever the
   * renderer's Rules UI updates. Always pass the full list — we don't
   * do incremental updates, easier to reason about.
   */
  setRules(rules) {
    this.rules = Array.isArray(rules) ? rules : [];
  }

  /**
   * Start the proxy listening on `port` (0 = auto-assign).
   *
   * Options:
   *   - port: TCP port to bind. 0 → OS-assigned.
   *   - onCapture: function(event) — called twice per request, once
   *     when the request is fully received (response field null) and
   *     once when the response is complete. Errors during forwarding
   *     emit a single response event with `response.error` set.
   *   - ca: CertificateAuthority instance from ./ca. If provided,
   *     CONNECT requests are intercepted and TLS-terminated using
   *     leaves minted by this CA. If null, CONNECT returns 501.
   */
  async start({ port = 0, onCapture, ca = null, upstreamCa = null, rejectUpstreamUnauthorized = true } = {}) {
    if (this.server) {
      throw new Error('CaptureServer already running on port ' + this.port);
    }
    this.onCapture = typeof onCapture === 'function' ? onCapture : null;
    this.ca = ca || null;
    // upstreamCa: extra trust roots for the outbound https leg (PEM string
    // or array of PEMs). Use for self-signed test origins or corporate
    // private CAs that aren't in Node's default trust store.
    this.upstreamCa = upstreamCa || null;
    // rejectUpstreamUnauthorized: if false, the proxy will capture HTTPS
    // even from origins with invalid certs. Off by default (secure).
    this.rejectUpstreamUnauthorized = rejectUpstreamUnauthorized;

    // Single HTTP server processes both:
    //   - plaintext requests (from forward-proxy clients) → _handle
    //   - TLS-decrypted requests (from CONNECT-then-TLS clients) → _handleTls
    // We dispatch based on the socket annotation we set on CONNECT.
    this.server = http.createServer((req, res) => {
      if (req.socket && req.socket.postnomadTarget) {
        this._handleTls(req, res);
      } else {
        this._handle(req, res);
      }
    });

    this.server.on('connect', (req, clientSocket, head) => this._onConnect(req, clientSocket, head));

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
    this.ca = null;
    this.upstreamCa = null;
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

  _onConnect(req, clientSocket, head) {
    if (!this.ca) {
      clientSocket.write(
        'HTTP/1.1 501 Not Implemented\r\n' +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'Postnomad capture proxy not configured for HTTPS (no CA wired).\n'
      );
      clientSocket.end();
      return;
    }

    const [host, portStr] = (req.url || '').split(':');
    if (!host) {
      clientSocket.end();
      return;
    }
    const targetPort = parseInt(portStr || '443', 10);

    clientSocket.on('error', () => {
      // Client closed mid-handshake — silent drop.
    });

    // Tell the client the tunnel is up. Once acknowledged, wrap the raw
    // socket in TLS using a Postnomad-minted leaf for `host` (SNI lets
    // the client request a different name if it wants). After the TLS
    // handshake completes, treat the decrypted socket as an HTTP
    // connection by emitting it on our shared HTTP server.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Postnomad\r\n\r\n', () => {
      if (head && head.length) clientSocket.unshift(head);

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        SNICallback: (sniHost, cb) => {
          try {
            const target = sniHost || host;
            const { certPem, keyPem } = this.ca.mintCertForHost(target);
            cb(null, tls.createSecureContext({ cert: certPem, key: keyPem }));
          } catch (err) {
            cb(err);
          }
        }
      });

      // Stamp the TLS socket so the HTTP-dispatch in this.server knows
      // this is a decrypted request and can reconstruct https://host…
      tlsSocket.postnomadTarget = { host, port: targetPort };

      tlsSocket.on('error', () => {
        // TLS errors (bad handshake, client dropped) — silent drop.
      });
      tlsSocket.on('_tlsError', () => {});

      // Hand the TLS socket to the HTTP server for parsing.
      this.server.emit('connection', tlsSocket);
    });
  }

  _handle(req, res) {
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

    if (targetUrl.protocol === 'https:') {
      // Direct https:// at the plain-HTTP forwarder is unusual (the normal
      // flow for HTTPS is CONNECT). Reject explicitly.
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Postnomad capture: send https:// via CONNECT, not as an absolute-URL GET/POST.\n');
      return;
    }
    if (targetUrl.protocol !== 'http:') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Postnomad capture: unsupported protocol ' + targetUrl.protocol + '\n');
      return;
    }

    this._proxyRequest({
      req,
      res,
      targetHost: targetUrl.hostname,
      targetPort: parseInt(targetUrl.port, 10) || 80,
      targetPath: targetUrl.pathname + targetUrl.search,
      transportModule: http,
      capturedAbsoluteUrl: req.url
    });
  }

  _handleTls(req, res) {
    const annot = req.socket && req.socket.postnomadTarget;
    if (!annot) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal: TLS socket missing Postnomad annotation\n');
      return;
    }
    const portSuffix = annot.port === 443 ? '' : `:${annot.port}`;
    const absoluteUrl = `https://${annot.host}${portSuffix}${req.url}`;

    this._proxyRequest({
      req,
      res,
      targetHost: annot.host,
      targetPort: annot.port,
      targetPath: req.url,
      transportModule: https,
      capturedAbsoluteUrl: absoluteUrl
    });
  }

  _proxyRequest({ req, res, targetHost, targetPort, targetPath, transportModule, capturedAbsoluteUrl }) {
    const captureId = randomUUID();
    this.captureCount += 1;
    const startedAt = Date.now();

    // Phase 5a: rule pre-flight. If a rule matches, divert (Map Local
    // = synthesize response; Map Remote = rewrite target then forward
    // normally). Rule decision happens BEFORE body buffering so we can
    // skip the upstream call entirely for Map Local.
    const rule = findMatchingRule(this.rules, req.method, capturedAbsoluteUrl);
    if (rule && rule.action === 'mapLocal') {
      this._handleMapLocal({ req, res, rule, captureId, startedAt, capturedAbsoluteUrl });
      return;
    }
    if (rule && rule.action === 'mapRemote') {
      const rewritten = this._rewriteForMapRemote({ rule, capturedAbsoluteUrl });
      if (rewritten) {
        targetHost = rewritten.host;
        targetPort = rewritten.port;
        targetPath = rewritten.path;
        transportModule = rewritten.transportModule;
        capturedAbsoluteUrl = rewritten.absoluteUrl;
      }
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
        url: capturedAbsoluteUrl,
        headers: { ...req.headers },
        body: bufferToDisplayString(requestBuffer, req.headers['content-type']),
        bodyBytes: reqByteCount,
        appliedRule: rule ? { id: rule.id, name: rule.name, action: rule.action } : null
      };

      this._emit({
        id: captureId,
        phase: 'request',
        timestamp: startedAt,
        request: requestRecord,
        response: null
      });

      const upstream = transportModule.request(
        {
          host: targetHost,
          port: targetPort,
          path: targetPath,
          method: req.method,
          headers: reqHeaders,
          // For https: validate the real origin's cert (we're a normal
          // client on this leg — the MITM only applies to the client-
          // facing leg). upstreamCa and rejectUpstreamUnauthorized let
          // tests and corporate setups override defaults.
          ...(transportModule === https
            ? {
                servername: targetHost,
                rejectUnauthorized: this.rejectUpstreamUnauthorized,
                ...(this.upstreamCa ? { ca: this.upstreamCa } : {})
              }
            : {})
        },
        (upstreamRes) => {
          const respChunks = [];
          let respByteCount = 0;
          upstreamRes.on('data', (chunk) => {
            respByteCount += chunk.length;
            res.write(chunk);
            if (respByteCount <= MAX_CAPTURED_BODY_BYTES) {
              respChunks.push(chunk);
            }
          });
          upstreamRes.on('end', () => {
            res.end();
            const rawBuffer = Buffer.concat(respChunks);
            const decoded = decodeBodyForDisplay(rawBuffer, upstreamRes.headers['content-encoding']);
            this._emit({
              id: captureId,
              phase: 'response',
              timestamp: startedAt,
              request: requestRecord,
              response: {
                status: upstreamRes.statusCode,
                statusText: upstreamRes.statusMessage,
                headers: { ...upstreamRes.headers },
                body: bufferToDisplayString(decoded, upstreamRes.headers['content-type']),
                bodyBytes: respByteCount,
                durationMs: Date.now() - startedAt
              }
            });
          });
          res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.headers);
        }
      );

      upstream.on('error', (err) => {
        if (!res.headersSent) {
          try {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
          } catch {
            // socket already torn down
          }
        }
        try {
          res.end();
        } catch {
          // ignore
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
      // Client aborted — drop quietly.
    });
  }

  _handleMapLocal({ req, res, rule, captureId, startedAt, capturedAbsoluteUrl }) {
    const cfg = rule.mapLocal || {};
    const filePath = cfg.filePath;
    const statusCode = Number.isInteger(cfg.statusCode) ? cfg.statusCode : 200;
    const contentType = cfg.contentType || 'application/octet-stream';

    // Consume + discard the incoming body so the connection unblocks
    // even though we're not forwarding it.
    let reqByteCount = 0;
    const reqChunks = [];
    req.on('data', (chunk) => {
      reqByteCount += chunk.length;
      if (reqByteCount <= MAX_CAPTURED_BODY_BYTES) reqChunks.push(chunk);
    });

    req.on('end', () => {
      const requestRecord = {
        method: req.method,
        url: capturedAbsoluteUrl,
        headers: { ...req.headers },
        body: bufferToDisplayString(Buffer.concat(reqChunks), req.headers['content-type']),
        bodyBytes: reqByteCount,
        appliedRule: { id: rule.id, name: rule.name, action: 'mapLocal' }
      };
      this._emit({
        id: captureId,
        phase: 'request',
        timestamp: startedAt,
        request: requestRecord,
        response: null
      });

      let bodyBuffer;
      let error = null;
      try {
        bodyBuffer = fs.readFileSync(filePath);
      } catch (err) {
        error = err.message;
      }

      if (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end(`Postnomad Map Local: cannot read ${filePath}: ${error}`);
        this._emit({
          id: captureId,
          phase: 'response',
          timestamp: startedAt,
          request: requestRecord,
          response: { error, durationMs: Date.now() - startedAt, appliedRule: requestRecord.appliedRule }
        });
        return;
      }

      const headers = {
        'Content-Type': contentType,
        'Content-Length': String(bodyBuffer.length),
        'X-Postnomad-Mock': 'map-local'
      };
      res.writeHead(statusCode, headers);
      res.end(bodyBuffer);

      this._emit({
        id: captureId,
        phase: 'response',
        timestamp: startedAt,
        request: requestRecord,
        response: {
          status: statusCode,
          statusText: 'OK',
          headers,
          body: bufferToDisplayString(bodyBuffer, contentType),
          bodyBytes: bodyBuffer.length,
          durationMs: Date.now() - startedAt,
          appliedRule: requestRecord.appliedRule
        }
      });
    });

    req.on('error', () => {});
  }

  _rewriteForMapRemote({ rule, capturedAbsoluteUrl }) {
    const targetUrl = rule.mapRemote && rule.mapRemote.targetUrl;
    if (!targetUrl) return null;
    try {
      const original = new URL(capturedAbsoluteUrl);
      const target = new URL(targetUrl);
      // The remote target's path becomes the new base; the original
      // path/query is appended UNLESS the rule's target URL ends with
      // `?` or `#`, in which case we honour what they wrote.
      let combinedPath = target.pathname || '/';
      if (combinedPath === '/' || combinedPath === '') {
        combinedPath = original.pathname + original.search;
      } else if (!combinedPath.endsWith('/') && (original.search || original.pathname !== '/')) {
        combinedPath = combinedPath + original.search;
      }
      const isHttps = target.protocol === 'https:';
      return {
        host: target.hostname,
        port: parseInt(target.port, 10) || (isHttps ? 443 : 80),
        path: combinedPath,
        transportModule: isHttps ? https : http,
        absoluteUrl: `${target.protocol}//${target.host}${combinedPath}`
      };
    } catch {
      return null;
    }
  }
}

module.exports = {
  CaptureServer,
  _internal: {
    stripHopByHopHeaders,
    decodeBodyForDisplay,
    bufferToDisplayString,
    HOP_BY_HOP_HEADERS,
    matchesRule,
    findMatchingRule
  }
};
