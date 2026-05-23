import each from 'lodash/each';
import get from 'lodash/get';
import { uuid } from '../common';

/**
 * Convert a parsed HAR (HTTP Archive) document into a Bruno collection.
 *
 * HAR is the standard interchange format exported by Chrome DevTools,
 * Proxyman, Charles, mitmproxy, Firefox, and most network-capture tools.
 * Importing a HAR file lets users turn real captured traffic into a
 * Bruno collection of replayable requests.
 *
 * Each HAR `entry` becomes one Bruno http-request item. Common auth
 * headers (Basic / Bearer) are lifted out of the headers into Bruno's
 * structured auth section. Bodies are mapped to Bruno body modes based
 * on mimeType.
 */

const DEFAULT_COLLECTION_NAME = 'HAR Capture';

const isHarFile = (data) => {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const log = data.log;
  if (!log || typeof log !== 'object') {
    return false;
  }
  if (typeof log.version !== 'string') {
    return false;
  }
  if (!Array.isArray(log.entries)) {
    return false;
  }
  return true;
};

const buildRequestName = (method, urlString, fallbackIndex) => {
  try {
    const u = new URL(urlString);
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '/';
    return `${method} ${path}`;
  } catch {
    return `${method} request ${fallbackIndex + 1}`;
  }
};

const stripQueryString = (urlString) => {
  try {
    const u = new URL(urlString);
    u.search = '';
    return u.toString();
  } catch {
    return urlString;
  }
};

const liftAuthFromHeaders = (harHeaders) => {
  // Returns { auth, headers } where auth is the Bruno auth object and
  // headers is the input minus the Authorization header (if matched).
  const auth = {
    mode: 'none',
    basic: null,
    bearer: null,
    digest: null
  };

  const authIdx = harHeaders.findIndex((h) => h.name && h.name.toLowerCase() === 'authorization');
  if (authIdx === -1) {
    return { auth, headers: harHeaders };
  }

  const headerValue = (harHeaders[authIdx].value || '').trim();
  const lower = headerValue.toLowerCase();

  if (lower.startsWith('basic ')) {
    const b64 = headerValue.slice(6).trim();
    try {
      // atob is available in browser; in Node tests we rely on Buffer.
      const decoded = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf-8');
      const sep = decoded.indexOf(':');
      const username = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const password = sep >= 0 ? decoded.slice(sep + 1) : '';
      auth.mode = 'basic';
      auth.basic = { username, password };
      return { auth, headers: harHeaders.filter((_, i) => i !== authIdx) };
    } catch {
      // Couldn't decode — leave header in place, no structured auth.
      return { auth, headers: harHeaders };
    }
  }

  if (lower.startsWith('bearer ')) {
    const token = headerValue.slice(7).trim();
    auth.mode = 'bearer';
    auth.bearer = { token };
    return { auth, headers: harHeaders.filter((_, i) => i !== authIdx) };
  }

  // Other auth schemes (Digest, AWS, NTLM, custom) — leave the header
  // as-is so it's preserved verbatim. Bruno's auth UI surfaces digest
  // and others but they require credentials we don't have from HAR.
  return { auth, headers: harHeaders };
};

const detectGraphqlBody = (mimeType, text) => {
  if (!text || typeof text !== 'string') {
    return null;
  }
  if (!mimeType || !mimeType.toLowerCase().includes('json')) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.query === 'string') {
      return {
        query: parsed.query,
        variables: parsed.variables ? JSON.stringify(parsed.variables, null, 2) : ''
      };
    }
  } catch {
    // not JSON
  }
  return null;
};

const buildBody = (postData) => {
  const body = {
    mode: 'none',
    json: null,
    text: null,
    xml: null,
    formUrlEncoded: [],
    multipartForm: []
  };

  if (!postData) {
    return { body, isGraphql: false, graphqlBody: null };
  }

  const rawMime = (postData.mimeType || '').toLowerCase();
  const mimeType = rawMime.split(';')[0].trim();
  const text = postData.text;

  // GraphQL detection (Bruno represents GraphQL as a request type, not a body mode)
  const gql = detectGraphqlBody(mimeType, text);
  if (gql) {
    return { body: { ...body, mode: 'graphql', graphql: gql }, isGraphql: true, graphqlBody: gql };
  }

  if (mimeType === 'application/json') {
    body.mode = 'json';
    body.json = text || '';
    return { body, isGraphql: false, graphqlBody: null };
  }

  if (mimeType === 'application/x-www-form-urlencoded') {
    body.mode = 'formUrlEncoded';
    if (Array.isArray(postData.params) && postData.params.length > 0) {
      each(postData.params, (param) => {
        body.formUrlEncoded.push({
          uid: uuid(),
          name: param.name || '',
          value: param.value || '',
          description: '',
          enabled: true
        });
      });
    } else if (text) {
      // Fall back to parsing the raw text body as urlencoded.
      try {
        const params = new URLSearchParams(text);
        params.forEach((value, name) => {
          body.formUrlEncoded.push({
            uid: uuid(),
            name,
            value,
            description: '',
            enabled: true
          });
        });
      } catch {
        body.mode = 'text';
        body.text = text;
      }
    }
    return { body, isGraphql: false, graphqlBody: null };
  }

  if (mimeType.startsWith('multipart/form-data')) {
    body.mode = 'multipartForm';
    if (Array.isArray(postData.params)) {
      each(postData.params, (param) => {
        // HAR multipart params may have `fileName` for file fields.
        body.multipartForm.push({
          uid: uuid(),
          type: param.fileName ? 'file' : 'text',
          name: param.name || '',
          value: param.fileName ? [] : param.value || '',
          description: '',
          enabled: true
        });
      });
    }
    return { body, isGraphql: false, graphqlBody: null };
  }

  if (mimeType === 'text/xml' || mimeType === 'application/xml') {
    body.mode = 'xml';
    body.xml = text || '';
    return { body, isGraphql: false, graphqlBody: null };
  }

  if (text) {
    body.mode = 'text';
    body.text = text;
  }
  return { body, isGraphql: false, graphqlBody: null };
};

const transformHarEntry = (entry, index, allEntries) => {
  const harRequest = entry.request || {};
  const method = (harRequest.method || 'GET').toUpperCase();
  const fullUrl = harRequest.url || '';

  // Bruno appends params at request time. If we leave them in the URL
  // AND list them under params, they'd be duplicated.
  const urlWithoutQuery = stripQueryString(fullUrl);

  const incomingHeaders = Array.isArray(harRequest.headers) ? harRequest.headers : [];
  const { auth, headers: headersAfterAuthLift } = liftAuthFromHeaders(incomingHeaders);

  // Filter out psuedo-headers (HTTP/2 :authority, :method, :path, :scheme)
  // that some HAR exporters include but which aren't valid in a request.
  const cleanHeaders = headersAfterAuthLift.filter((h) => h.name && !h.name.startsWith(':'));

  const item = {
    uid: uuid(),
    name: buildRequestName(method, fullUrl, index),
    type: 'http-request',
    request: {
      url: urlWithoutQuery,
      method,
      auth,
      headers: cleanHeaders.map((h) => ({
        uid: uuid(),
        name: h.name,
        value: h.value || '',
        description: '',
        enabled: true
      })),
      params: [],
      body: {
        mode: 'none',
        json: null,
        text: null,
        xml: null,
        formUrlEncoded: [],
        multipartForm: []
      }
    }
  };

  const harParams = Array.isArray(harRequest.queryString) ? harRequest.queryString : [];
  each(harParams, (param) => {
    item.request.params.push({
      uid: uuid(),
      name: param.name || '',
      value: param.value || '',
      description: '',
      type: 'query',
      enabled: true
    });
  });

  const { body, isGraphql, graphqlBody } = buildBody(harRequest.postData);
  item.request.body = body;
  if (isGraphql) {
    item.type = 'graphql-request';
    item.request.body.graphql = graphqlBody;
  }

  return item;
};

const inferCollectionName = (har) => {
  const log = har.log || {};
  const firstPage = Array.isArray(log.pages) && log.pages.length ? log.pages[0] : null;
  if (firstPage && typeof firstPage.title === 'string' && firstPage.title.trim()) {
    return firstPage.title.trim().slice(0, 80);
  }
  const creatorName = get(log, 'creator.name');
  if (typeof creatorName === 'string' && creatorName.trim()) {
    return `${creatorName.trim()} capture`;
  }
  return DEFAULT_COLLECTION_NAME;
};

const harToBruno = (har) => {
  if (!isHarFile(har)) {
    throw new Error('Not a valid HAR file (missing log/entries).');
  }

  const entries = har.log.entries;

  const items = entries
    .filter((entry) => entry && entry.request && typeof entry.request.url === 'string')
    .map((entry, index, all) => transformHarEntry(entry, index, all));

  return {
    name: inferCollectionName(har),
    uid: uuid(),
    version: '1',
    items,
    environments: []
  };
};

export default harToBruno;
export { isHarFile };
