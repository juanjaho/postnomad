const http = require('http');
const zlib = require('zlib');
const { CaptureServer, _internal } = require('./captureServer');
const { stripHopByHopHeaders, decodeBodyForDisplay, bufferToDisplayString } = _internal;

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

  it('returns 400 for non-http upstream protocols (https comes in Phase 4)', async () => {
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
    expect(result.body).toMatch(/Phase 4/);
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
