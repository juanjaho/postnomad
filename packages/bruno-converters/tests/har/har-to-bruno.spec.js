import harToBruno, { isHarFile } from '../../src/har/har-to-bruno';

const sampleHar = {
  log: {
    version: '1.2',
    creator: { name: 'Chrome DevTools', version: '120' },
    entries: [
      {
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 42,
        request: {
          method: 'GET',
          url: 'https://api.example.com/users?limit=10&offset=0',
          httpVersion: 'HTTP/1.1',
          headers: [
            { name: 'Accept', value: 'application/json' },
            { name: 'Authorization', value: 'Bearer abc.def.ghi' }
          ],
          queryString: [
            { name: 'limit', value: '10' },
            { name: 'offset', value: '0' }
          ],
          cookies: [],
          headersSize: -1,
          bodySize: 0
        },
        response: { status: 200, statusText: 'OK', headers: [] },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 }
      },
      {
        startedDateTime: '2026-01-01T00:00:01.000Z',
        time: 100,
        request: {
          method: 'POST',
          url: 'https://api.example.com/users',
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: 'Basic ' + Buffer.from('alice:secret').toString('base64') }
          ],
          queryString: [],
          postData: {
            mimeType: 'application/json',
            text: '{"name":"Alice"}'
          },
          cookies: []
        },
        response: { status: 201 }
      },
      {
        startedDateTime: '2026-01-01T00:00:02.000Z',
        time: 50,
        request: {
          method: 'POST',
          url: 'https://forms.example.com/submit',
          headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
          queryString: [],
          postData: {
            mimeType: 'application/x-www-form-urlencoded',
            text: 'foo=1&bar=two',
            params: [
              { name: 'foo', value: '1' },
              { name: 'bar', value: 'two' }
            ]
          },
          cookies: []
        },
        response: { status: 200 }
      },
      {
        startedDateTime: '2026-01-01T00:00:03.000Z',
        time: 75,
        request: {
          method: 'POST',
          url: 'https://gql.example.com/graphql',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          queryString: [],
          postData: {
            mimeType: 'application/json',
            text: '{"query":"query Q { users { id } }","variables":{"x":1}}'
          },
          cookies: []
        },
        response: { status: 200 }
      }
    ]
  }
};

describe('harToBruno', () => {
  it('rejects non-HAR input', () => {
    expect(isHarFile(null)).toBe(false);
    expect(isHarFile({})).toBe(false);
    expect(isHarFile({ log: {} })).toBe(false);
    expect(isHarFile({ log: { version: '1.2' } })).toBe(false);
    expect(isHarFile({ log: { version: '1.2', entries: [] } })).toBe(true);
    expect(isHarFile(sampleHar)).toBe(true);
  });

  it('throws on invalid HAR', () => {
    expect(() => harToBruno({ not: 'har' })).toThrow();
  });

  it('produces a Bruno collection with one item per HAR entry', () => {
    const collection = harToBruno(sampleHar);
    expect(collection.name).toContain('capture');
    expect(collection.items).toHaveLength(4);
    expect(collection.version).toBe('1');
    expect(collection.environments).toEqual([]);
    expect(collection.uid).toBeTruthy();
  });

  it('strips query string from URL and exposes it as params', () => {
    const collection = harToBruno(sampleHar);
    const getUsers = collection.items[0];
    expect(getUsers.request.url).toBe('https://api.example.com/users');
    expect(getUsers.request.params).toEqual([
      expect.objectContaining({ name: 'limit', value: '10', type: 'query', enabled: true }),
      expect.objectContaining({ name: 'offset', value: '0', type: 'query', enabled: true })
    ]);
  });

  it('lifts Bearer token auth out of headers into structured auth', () => {
    const collection = harToBruno(sampleHar);
    const getUsers = collection.items[0];
    expect(getUsers.request.auth.mode).toBe('bearer');
    expect(getUsers.request.auth.bearer).toEqual({ token: 'abc.def.ghi' });
    expect(getUsers.request.headers.some((h) => h.name.toLowerCase() === 'authorization')).toBe(false);
  });

  it('lifts Basic auth out of headers and decodes credentials', () => {
    const collection = harToBruno(sampleHar);
    const postUser = collection.items[1];
    expect(postUser.request.auth.mode).toBe('basic');
    expect(postUser.request.auth.basic).toEqual({ username: 'alice', password: 'secret' });
    expect(postUser.request.headers.some((h) => h.name.toLowerCase() === 'authorization')).toBe(false);
  });

  it('maps JSON bodies to body.json', () => {
    const collection = harToBruno(sampleHar);
    const postUser = collection.items[1];
    expect(postUser.request.body.mode).toBe('json');
    expect(postUser.request.body.json).toBe('{"name":"Alice"}');
  });

  it('maps urlencoded bodies to formUrlEncoded entries', () => {
    const collection = harToBruno(sampleHar);
    const formPost = collection.items[2];
    expect(formPost.request.body.mode).toBe('formUrlEncoded');
    expect(formPost.request.body.formUrlEncoded).toEqual([
      expect.objectContaining({ name: 'foo', value: '1', enabled: true }),
      expect.objectContaining({ name: 'bar', value: 'two', enabled: true })
    ]);
  });

  it('detects GraphQL requests and switches the item type', () => {
    const collection = harToBruno(sampleHar);
    const gql = collection.items[3];
    expect(gql.type).toBe('graphql-request');
    expect(gql.request.body.mode).toBe('graphql');
    expect(gql.request.body.graphql.query).toBe('query Q { users { id } }');
    expect(gql.request.body.graphql.variables).toBe('{\n  "x": 1\n}');
  });

  it('uses METHOD path as the request name', () => {
    const collection = harToBruno(sampleHar);
    expect(collection.items[0].name).toBe('GET /users');
    expect(collection.items[1].name).toBe('POST /users');
    expect(collection.items[2].name).toBe('POST /submit');
  });

  it('skips entries with no request URL', () => {
    const malformed = {
      log: {
        version: '1.2',
        entries: [{ request: { method: 'GET' } }, ...sampleHar.log.entries]
      }
    };
    const collection = harToBruno(malformed);
    expect(collection.items).toHaveLength(4);
  });
});
