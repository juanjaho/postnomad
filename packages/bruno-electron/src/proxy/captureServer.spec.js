const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const zlib = require('zlib');
const { CaptureServer, _internal } = require('./captureServer');
const { CertificateAuthority } = require('./ca');
const { stripHopByHopHeaders, decodeBodyForDisplay, bufferToDisplayString, matchesRule, findMatchingRule } = _internal;

describe('CaptureServer internals', () => {
  it('strips RFC 7230 hop-by-hop headers', () => {
    const out = stripHopByHopHeaders({
      'content-type': 'application/json',
      Connection: 'keep-alive',
      'Proxy-Authorization': 'Bearer x',
      'Transfer-Encoding': 'chunked',
      'X-Real-Header': 'pass'
    });
    expect(out).toEqual({
      'content-type': 'application/json',
      'X-Real-Header': 'pass'
    });
  });

  it('decodes gzip / deflate / br response bodies for display', () => {
    const text = 'hello postnomad';
    const gz = zlib.gzipSync(Buffer.from(text));
    const df = zlib.deflateSync(Buffer.from(text));
    const br = zlib.brotliCompressSync(Buffer.from(text));

    expect(decodeBodyForDisplay(gz, 'gzip').toString()).toBe(text);
    expect(decodeBodyForDisplay(df, 'deflate').toString()).toBe(text);
    expect(decodeBodyForDisplay(br, 'br').toString()).toBe(text);
    // Unknown encoding: pass through.
    expect(decodeBodyForDisplay(Buffer.from(text), 'lzma').toString()).toBe(text);
  });

  it('marks binary content as [binary N bytes] in display string', () => {
    expect(bufferToDisplayString(Buffer.from([0, 1, 2, 3]), 'image/png')).toMatch(/^\[binary 4 bytes\]$/);
    expect(bufferToDisplayString(Buffer.from('hi'), 'text/plain')).toBe('hi');
    expect(bufferToDisplayString(Buffer.from('{"a":1}'), 'application/json')).toBe('{"a":1}');
  });
});

describe('CaptureServer end-to-end (real HTTP roundtrip)', () => {
  let origin;
  let originPort;
  let proxy;
  let captureEvents;

  beforeAll(async () => {
    // Stand up a fake origin server.
    origin = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Origin': 'true' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
        return;
      }
      if (req.url === '/echo' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          res.writeHead(201, { 'Content-Type': 'text/plain' });
          res.end('echo:' + body);
        });
        return;
      }
      if (req.url === '/boom') {
        req.socket.destroy();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    originPort = origin.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => origin.close(resolve));
  });

  beforeEach(async () => {
    captureEvents = [];
    proxy = new CaptureServer();
    await proxy.start({
      port: 0,
      onCapture: (ev) => captureEvents.push(ev)
    });
  });

  afterEach(async () => {
    await proxy.stop();
  });

  const proxyGet = (path) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: `http://127.0.0.1:${originPort}${path}`
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

  const proxyPost = (path, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: `http://127.0.0.1:${originPort}${path}`,
          headers: { 'Content-Type': 'text/plain' }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  it('forwards GET requests and pass-through responses byte-perfect', async () => {
    const result = await proxyGet('/json');
    expect(result.status).toBe(200);
    expect(result.headers['x-origin']).toBe('true');
    expect(JSON.parse(result.body)).toEqual({ ok: true, path: '/json' });
  });

  it('emits a request event and a response event per roundtrip', async () => {
    await proxyGet('/json');
    expect(captureEvents).toHaveLength(2);
    expect(captureEvents[0].phase).toBe('request');
    expect(captureEvents[0].response).toBeNull();
    expect(captureEvents[1].phase).toBe('response');
    expect(captureEvents[1].response.status).toBe(200);
    expect(captureEvents[1].response.headers['x-origin']).toBe('true');
    expect(captureEvents[0].request.method).toBe('GET');
    expect(captureEvents[0].request.url).toContain('/json');
  });

  it('forwards POST bodies and captures them in the request record', async () => {
    const result = await proxyPost('/echo', 'hi-there');
    expect(result.status).toBe(201);
    expect(result.body).toBe('echo:hi-there');
    const responseEvent = captureEvents.find((e) => e.phase === 'response');
    expect(responseEvent.request.body).toBe('hi-there');
    expect(responseEvent.response.status).toBe(201);
    expect(responseEvent.response.body).toBe('echo:hi-there');
    expect(responseEvent.response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 400 to clients that send non-absolute URLs', async () => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/relative' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatch(/absolute URL/);
  });

  it('rejects direct absolute-URL https:// (should be CONNECT)', async () => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: 'https://example.com/nope'
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatch(/CONNECT/);
  });

  it('refuses CONNECT (HTTPS tunneling) when no CA is wired', async () => {
    // Send a raw CONNECT and read the response status line.
    const { Socket } = require('net');
    const status = await new Promise((resolve, reject) => {
      const sock = new Socket();
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('\r\n')) {
          resolve(buf.split('\r\n')[0]);
          sock.destroy();
        }
      });
      sock.on('error', reject);
      sock.connect(proxy.port, '127.0.0.1', () => {
        sock.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
    });
    expect(status).toMatch(/501/);
  });

  it('captures upstream errors with a 502 to the client and an error event', async () => {
    const result = await proxyGet('/boom');
    expect(result.status).toBe(502);
    const responseEvent = captureEvents.find((e) => e.phase === 'response');
    expect(responseEvent.response.error).toBeTruthy();
  });

  it('rejects double-start', async () => {
    await expect(proxy.start({ port: 0, onCapture: () => {} })).rejects.toThrow(/already running/);
  });

  it('isRunning toggles correctly across stop/start', async () => {
    expect(proxy.isRunning()).toBe(true);
    await proxy.stop();
    expect(proxy.isRunning()).toBe(false);
    await proxy.start({ port: 0, onCapture: () => {} });
    expect(proxy.isRunning()).toBe(true);
  });
});

describe('Rules engine (Phase 5a) — matcher semantics', () => {
  const ruleFor = (overrides = {}) => ({
    id: 'r1',
    enabled: true,
    name: 'r',
    matcher: { urlPattern: '', method: '*' },
    action: 'mapLocal',
    ...overrides
  });

  it('substring match by default', () => {
    expect(
      matchesRule(ruleFor({ matcher: { urlPattern: '/api/users', method: '*' } }), 'GET', 'http://x/api/users')
    ).toBe(true);
    expect(
      matchesRule(ruleFor({ matcher: { urlPattern: '/api/users', method: '*' } }), 'GET', 'http://x/api/orders')
    ).toBe(false);
  });

  it('regex match when pattern is /.../', () => {
    const r = ruleFor({ matcher: { urlPattern: '/^https:\\/\\/api\\.example\\.com\\/users\\/\\d+$/', method: '*' } });
    expect(matchesRule(r, 'GET', 'https://api.example.com/users/42')).toBe(true);
    expect(matchesRule(r, 'GET', 'https://api.example.com/users/foo')).toBe(false);
  });

  it('method filter is case-insensitive; * matches any', () => {
    const r = ruleFor({ matcher: { urlPattern: '/api', method: 'POST' } });
    expect(matchesRule(r, 'post', 'http://x/api')).toBe(true);
    expect(matchesRule(r, 'GET', 'http://x/api')).toBe(false);
    expect(matchesRule(ruleFor({ matcher: { urlPattern: '/api', method: '*' } }), 'GET', 'http://x/api')).toBe(true);
  });

  it('disabled rules never match', () => {
    expect(
      matchesRule(ruleFor({ enabled: false, matcher: { urlPattern: '/x', method: '*' } }), 'GET', 'http://x/x')
    ).toBe(false);
  });

  it('first matching rule wins', () => {
    const rules = [
      ruleFor({ id: 'a', matcher: { urlPattern: '/api', method: '*' }, action: 'mapLocal' }),
      ruleFor({ id: 'b', matcher: { urlPattern: '/api/users', method: '*' }, action: 'mapRemote' })
    ];
    expect(findMatchingRule(rules, 'GET', 'http://x/api/users').id).toBe('a');
  });

  it('returns null when nothing matches', () => {
    expect(
      findMatchingRule([ruleFor({ matcher: { urlPattern: '/nope', method: '*' } })], 'GET', 'http://x/y')
    ).toBeNull();
    expect(findMatchingRule([], 'GET', 'http://x/y')).toBeNull();
  });
});

describe('CaptureServer — Map Local (Phase 5a)', () => {
  let proxy;
  let captureEvents;
  let tmpFile;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postnomad-maplocal-'));
    tmpFile = path.join(tmpDir, 'response.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ mocked: true, source: 'map-local' }));

    captureEvents = [];
    proxy = new CaptureServer();
    proxy.setRules([
      {
        id: 'rule1',
        enabled: true,
        name: 'mock users',
        matcher: { urlPattern: '/api/users', method: '*' },
        action: 'mapLocal',
        mapLocal: { filePath: tmpFile, statusCode: 201, contentType: 'application/json' }
      }
    ]);
    await proxy.start({ port: 0, onCapture: (ev) => captureEvents.push(ev) });
  });

  afterEach(async () => {
    await proxy.stop();
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it('serves the local file instead of forwarding upstream', async () => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: 'http://unreachable.example.invalid/api/users'
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(result.status).toBe(201);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['x-postnomad-mock']).toBe('map-local');
    expect(JSON.parse(result.body)).toEqual({ mocked: true, source: 'map-local' });

    const responseEvent = captureEvents.find((e) => e.phase === 'response');
    expect(responseEvent.request.appliedRule.action).toBe('mapLocal');
    expect(responseEvent.response.appliedRule.id).toBe('rule1');
  });

  it('returns 500 with diagnostic when the local file is missing', async () => {
    fs.unlinkSync(tmpFile);
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: 'http://x.invalid/api/users'
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(500);
    expect(result.body).toMatch(/Map Local/);
  });
});

describe('CaptureServer — Map Remote (Phase 5a)', () => {
  let originServer;
  let originPort;
  let proxy;
  let captureEvents;

  beforeAll(async () => {
    originServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Origin': 'rewritten' });
      res.end(JSON.stringify({ rewritten: true, path: req.url }));
    });
    await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    originPort = originServer.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => originServer.close(resolve));
  });

  beforeEach(async () => {
    captureEvents = [];
    proxy = new CaptureServer();
    proxy.setRules([
      {
        id: 'remote1',
        enabled: true,
        name: 'redirect users to local origin',
        matcher: { urlPattern: 'api.example.com', method: '*' },
        action: 'mapRemote',
        mapRemote: { targetUrl: `http://127.0.0.1:${originPort}` }
      }
    ]);
    await proxy.start({ port: 0, onCapture: (ev) => captureEvents.push(ev) });
  });

  afterEach(async () => {
    await proxy.stop();
  });

  it('rewrites the upstream host and preserves the original path', async () => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: 'http://api.example.com/users/42'
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(200);
    expect(result.headers['x-origin']).toBe('rewritten');
    expect(JSON.parse(result.body)).toEqual({ rewritten: true, path: '/users/42' });

    const responseEvent = captureEvents.find((e) => e.phase === 'response');
    expect(responseEvent.request.appliedRule.action).toBe('mapRemote');
    // capturedAbsoluteUrl reflects the REWRITTEN URL so users can see
    // what actually got sent.
    expect(responseEvent.request.url).toBe(`http://127.0.0.1:${originPort}/users/42`);
  });
});

describe('CaptureServer — Breakpoints (Phase 5b)', () => {
  let originServer;
  let originPort;
  let proxy;
  let captureEvents;
  let pausedRequests;

  beforeAll(async () => {
    originServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, path: req.url, gotBody: body, headers: req.headers }));
      });
    });
    await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    originPort = originServer.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => originServer.close(resolve));
  });

  beforeEach(async () => {
    captureEvents = [];
    pausedRequests = [];
    proxy = new CaptureServer();
    proxy.setRules([
      {
        id: 'bp1',
        enabled: true,
        name: 'pause writes',
        matcher: { urlPattern: '/api/write', method: 'POST' },
        action: 'breakpoint'
      }
    ]);
    await proxy.start({
      port: 0,
      onCapture: (ev) => captureEvents.push(ev),
      onBreakpoint: (pause) => pausedRequests.push(pause)
    });
  });

  afterEach(async () => {
    await proxy.stop();
  });

  const proxyPost = (path, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: `http://127.0.0.1:${originPort}${path}`,
          headers: { 'Content-Type': 'text/plain' }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  it('pauses matching requests and resumes when the renderer forwards them', async () => {
    const responsePromise = proxyPost('/api/write', 'original-body');

    // Spin until the breakpoint fires.
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (pausedRequests.length) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });

    const paused = pausedRequests[0];
    expect(paused.request.method).toBe('POST');
    expect(paused.request.body).toBe('original-body');
    expect(paused.ruleId).toBe('bp1');

    const resolved = proxy.resolveBreakpoint(paused.id, 'forward', {});
    expect(resolved).toBe(true);

    const result = await responsePromise;
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.gotBody).toBe('original-body');
  });

  it('cancel resolves with a 499 and does not hit the origin', async () => {
    let originHits = 0;
    const cancelOrigin = http.createServer((req, res) => {
      originHits += 1;
      res.writeHead(200);
      res.end();
    });
    await new Promise((resolve) => cancelOrigin.listen(0, '127.0.0.1', resolve));
    const cancelPort = cancelOrigin.address().port;

    try {
      const responsePromise = new Promise((resolve, reject) => {
        const r = http.request(
          {
            host: '127.0.0.1',
            port: proxy.port,
            method: 'POST',
            path: `http://127.0.0.1:${cancelPort}/api/write`,
            headers: { 'Content-Type': 'text/plain' }
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          }
        );
        r.on('error', reject);
        r.write('payload');
        r.end();
      });

      await new Promise((resolve) => {
        const t = setInterval(() => {
          if (pausedRequests.length) {
            clearInterval(t);
            resolve();
          }
        }, 10);
      });

      proxy.resolveBreakpoint(pausedRequests[0].id, 'cancel');

      const result = await responsePromise;
      expect(result.status).toBe(499);
      expect(result.body).toMatch(/cancelled/);
      expect(originHits).toBe(0);
    } finally {
      await new Promise((resolve) => cancelOrigin.close(resolve));
    }
  });

  it('forward with edited body replaces what goes upstream', async () => {
    const responsePromise = proxyPost('/api/write', 'original');

    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (pausedRequests.length) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });

    proxy.resolveBreakpoint(pausedRequests[0].id, 'forward', { body: 'edited-by-user' });

    const result = await responsePromise;
    const parsed = JSON.parse(result.body);
    expect(parsed.gotBody).toBe('edited-by-user');
  });

  it('resolveBreakpoint on an unknown id is a safe no-op', () => {
    expect(proxy.resolveBreakpoint('nope', 'cancel')).toBe(false);
  });

  it('stop() cancels any pending breakpoints so client sockets do not hang', async () => {
    const responsePromise = proxyPost('/api/write', 'will-be-cancelled');

    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (pausedRequests.length) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    expect(proxy.pendingBreakpoints.size).toBe(1);

    await proxy.stop();
    const result = await responsePromise;
    expect(result.status).toBe(499);
  });
});

describe('CaptureServer — HTTPS interception via minted CA (Phase 4b/c)', () => {
  let tmpDir;
  let ca;
  let proxy;
  let captureEvents;
  let originServer;
  let originPort;
  let originCertPem;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postnomad-capture-tls-test-'));
    ca = new CertificateAuthority({ storageDir: tmpDir });
    await ca.ensureCa();

    // Stand up a real HTTPS origin. We re-use Postnomad-minted certs so
    // we don't need to drag in another cert lib; the proxy's outbound
    // leg trusts our CA via the upstreamCa option.
    const { certPem, keyPem } = ca.mintCertForHost('localhost');
    originCertPem = ca.getCaCertPem();
    originServer = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, tls: true }));
    });
    await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    originPort = originServer.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => originServer.close(resolve));
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    captureEvents = [];
    proxy = new CaptureServer();
    await proxy.start({
      port: 0,
      ca,
      upstreamCa: originCertPem,
      onCapture: (ev) => captureEvents.push(ev)
    });
  });

  afterEach(async () => {
    await proxy.stop();
  });

  it('decrypts an HTTPS request tunneled through CONNECT and captures the plaintext', async () => {
    // Use https-proxy-agent (already a project dep) to do the CONNECT
    // dance: it speaks CONNECT to our proxy, upgrades to TLS on the
    // returned socket trusting our Postnomad CA, and issues a real
    // HTTPS GET. Tests the full client-facing path end-to-end.
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${proxy.port}`);

    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: 'localhost',
          port: originPort,
          path: '/api/users',
          method: 'GET',
          agent,
          // Trust our Postnomad CA so the leaf the proxy mints validates.
          // (In production, Phase 4d will install this CA into the OS
          // trust store so apps don't need to pass it explicitly.)
          ca: ca.getCaCertPem(),
          servername: 'localhost'
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed).toEqual({ ok: true, path: '/api/users', method: 'GET', tls: true });

    // The capture pipeline saw the decrypted request + response.
    const responseEvent = captureEvents.find((e) => e.phase === 'response');
    expect(responseEvent).toBeTruthy();
    expect(responseEvent.request.method).toBe('GET');
    expect(responseEvent.request.url).toBe(`https://localhost:${originPort}/api/users`);
    expect(responseEvent.response.status).toBe(200);
    expect(JSON.parse(responseEvent.response.body)).toEqual({
      ok: true,
      path: '/api/users',
      method: 'GET',
      tls: true
    });
  }, 15000);
});
