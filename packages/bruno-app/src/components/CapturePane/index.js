import React, { useState, useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Modal from 'components/Modal';
import { closePanel, clearEvents, removeEvent, setStatus } from 'providers/ReduxStore/slices/capture';
import { newHttpRequest } from 'providers/ReduxStore/slices/collections/actions';
import { uuid } from 'utils/common';
import toast from 'react-hot-toast';

// Mirrors the lift/strip logic in the HAR converter — keeps capture-save
// behaviour consistent with file import.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'host',
  'content-length'
]);

const captureToRequestFields = (event) => {
  const req = event.request || {};
  const url = req.url || '';
  let cleanUrl = url;
  try {
    const u = new URL(url);
    u.search = '';
    cleanUrl = u.toString();
  } catch {
    // leave as-is
  }

  const auth = { mode: 'none', basic: null, bearer: null, digest: null };
  const headers = [];
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'authorization') {
      const v = String(value).trim();
      const lower = v.toLowerCase();
      if (lower.startsWith('bearer ')) {
        auth.mode = 'bearer';
        auth.bearer = { token: v.slice(7).trim() };
        continue;
      }
      if (lower.startsWith('basic ')) {
        try {
          const decoded = atob(v.slice(6).trim());
          const sep = decoded.indexOf(':');
          auth.mode = 'basic';
          auth.basic = {
            username: sep >= 0 ? decoded.slice(0, sep) : decoded,
            password: sep >= 0 ? decoded.slice(sep + 1) : ''
          };
          continue;
        } catch {
          // fall through to keep header
        }
      }
    }
    headers.push({ uid: uuid(), name, value: String(value), description: '', enabled: true });
  }

  const ctype = (req.headers?.['content-type'] || req.headers?.['Content-Type'] || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  let body = null;
  if (req.body && req.body !== '' && !req.body.startsWith('[binary ')) {
    body = {
      mode: 'none',
      json: null,
      text: null,
      xml: null,
      sparql: null,
      multipartForm: [],
      formUrlEncoded: [],
      file: []
    };
    if (ctype === 'application/json') {
      body.mode = 'json';
      body.json = req.body;
    } else if (ctype === 'application/xml' || ctype === 'text/xml') {
      body.mode = 'xml';
      body.xml = req.body;
    } else {
      body.mode = 'text';
      body.text = req.body;
    }
  }

  let pathPart = '/';
  try {
    const u = new URL(url);
    pathPart = u.pathname || '/';
  } catch {
    // ignore
  }

  return {
    requestName: `Captured: ${req.method || 'GET'} ${pathPart}`,
    filename: `captured-${(req.method || 'get').toLowerCase()}-${Date.now()}`,
    requestType: 'http-request',
    requestUrl: cleanUrl,
    requestMethod: req.method || 'GET',
    headers,
    body,
    auth
  };
};

/**
 * Postnomad live HTTP capture pane (Phase 3b of the Proxyman roadmap).
 *
 * Drives the main-process capture proxy through three IPC channels:
 *   renderer:capture-start, renderer:capture-stop, renderer:capture-status.
 * Events arrive over main:capture-event and are dispatched into the
 * capture Redux slice from useIpcEvents — this component just renders.
 */

const DEFAULT_PORT = 9999;

const methodBadgeStyle = (method) => {
  const m = (method || '').toUpperCase();
  const color =
    m === 'GET'
      ? 'var(--color-status-success-text, #16a34a)'
      : m === 'POST'
        ? 'var(--color-status-info-text, #2563eb)'
        : m === 'PUT' || m === 'PATCH'
          ? 'var(--color-status-warning-text, #d97706)'
          : m === 'DELETE'
            ? 'var(--color-status-danger-text, #dc2626)'
            : 'var(--color-text-muted, #6b7280)';
  return { color, fontWeight: 600, fontSize: 11 };
};

const statusBadgeStyle = (status) => {
  if (status == null) return { color: 'var(--color-text-muted, #6b7280)', fontSize: 11 };
  const color =
    status < 300
      ? 'var(--color-status-success-text, #16a34a)'
      : status < 400
        ? 'var(--color-status-info-text, #2563eb)'
        : status < 500
          ? 'var(--color-status-warning-text, #d97706)'
          : 'var(--color-status-danger-text, #dc2626)';
  return { color, fontSize: 11, fontWeight: 600 };
};

const CaptureEventRow = ({ event, expanded, onToggle, onRemove, onSave, canSave }) => {
  const req = event.request || {};
  const res = event.response;
  let host = '';
  let path = req.url || '';
  try {
    const u = new URL(req.url);
    host = u.host;
    path = u.pathname + u.search;
  } catch {
    // leave as-is
  }

  const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';

  return (
    <div className="border rounded mb-1" style={{ borderColor: 'var(--color-border-default)' }}>
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer text-xs"
        onClick={onToggle}
        data-testid="capture-row"
      >
        <span style={{ color: 'var(--color-text-muted)', minWidth: 64 }}>{ts}</span>
        <span style={methodBadgeStyle(req.method)}>{req.method}</span>
        <span style={statusBadgeStyle(res?.status)}>{res?.status ?? (res?.error ? 'ERR' : '…')}</span>
        <span className="truncate" style={{ color: 'var(--color-text-muted)' }}>
          {host}
        </span>
        <span className="truncate flex-1">{path}</span>
        {res?.durationMs != null && (
          <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{res.durationMs}ms</span>
        )}
        {canSave && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSave();
            }}
            className="text-xs opacity-70 hover:opacity-100 underline"
            data-testid="capture-save"
          >
            Save
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="text-xs opacity-50 hover:opacity-100"
          aria-label="Remove capture"
        >
          ×
        </button>
      </div>
      {expanded && (
        <div className="px-3 py-2 text-xs border-t" style={{ borderColor: 'var(--color-border-default)' }}>
          <div className="mb-3">
            <div className="font-semibold mb-1">Request</div>
            <div className="opacity-70 mb-1">
              {req.method} {req.url}
            </div>
            <details className="mb-2">
              <summary className="cursor-pointer">Headers ({Object.keys(req.headers || {}).length})</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(req.headers, null, 2)}</pre>
            </details>
            {req.body && (
              <details>
                <summary className="cursor-pointer">Body ({req.bodyBytes ?? req.body.length} bytes)</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all">{req.body}</pre>
              </details>
            )}
          </div>
          <div>
            <div className="font-semibold mb-1">Response</div>
            {res?.error ? (
              <div style={{ color: 'var(--color-status-danger-text)' }}>Error: {res.error}</div>
            ) : res ? (
              <>
                <div className="opacity-70 mb-1">
                  {res.status} {res.statusText} {res.durationMs != null && `(${res.durationMs}ms)`}
                </div>
                <details className="mb-2">
                  <summary className="cursor-pointer">Headers ({Object.keys(res.headers || {}).length})</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(res.headers, null, 2)}</pre>
                </details>
                {res.body && (
                  <details>
                    <summary className="cursor-pointer">Body ({res.bodyBytes ?? res.body.length} bytes)</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all">{res.body}</pre>
                  </details>
                )}
              </>
            ) : (
              <div className="opacity-50">Pending…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const CapturePane = () => {
  const dispatch = useDispatch();
  const { panelOpen, running, port, events } = useSelector((state) => state.capture);
  const collections = useSelector((state) => state.collections.collections || []);
  const [portInput, setPortInput] = useState(port || DEFAULT_PORT);
  const [expandedId, setExpandedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveTargetUid, setSaveTargetUid] = useState('');

  const onClose = useCallback(() => dispatch(closePanel()), [dispatch]);

  const onStart = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.ipcRenderer.invoke('renderer:capture-start', {
        port: Number(portInput) || DEFAULT_PORT
      });
      dispatch(setStatus({ running: true, port: result.port }));
      toast.success(`Capture proxy listening on 127.0.0.1:${result.port}`);
    } catch (err) {
      toast.error(err.message || 'Could not start capture proxy');
    } finally {
      setBusy(false);
    }
  }, [dispatch, portInput]);

  const onStop = useCallback(async () => {
    setBusy(true);
    try {
      await window.ipcRenderer.invoke('renderer:capture-stop');
      dispatch(setStatus({ running: false, port: null }));
    } catch (err) {
      toast.error(err.message || 'Could not stop capture proxy');
    } finally {
      setBusy(false);
    }
  }, [dispatch]);

  const onClear = useCallback(() => dispatch(clearEvents()), [dispatch]);
  const onRemove = useCallback((id) => dispatch(removeEvent(id)), [dispatch]);

  const onSave = useCallback(
    async (event) => {
      if (!saveTargetUid) {
        toast.error('Pick a target collection first');
        return;
      }
      try {
        await dispatch(
          newHttpRequest({
            ...captureToRequestFields(event),
            collectionUid: saveTargetUid,
            itemUid: null
          })
        );
        toast.success('Saved capture as a new request');
      } catch (err) {
        toast.error(err.message || 'Could not save capture');
      }
    },
    [dispatch, saveTargetUid]
  );

  const proxyUrl = useMemo(() => (port ? `http://127.0.0.1:${port}` : null), [port]);

  if (!panelOpen) return null;

  return (
    <Modal size="lg" title="Capture HTTP Traffic" hideFooter handleCancel={onClose}>
      <div className="flex flex-col gap-3 h-[600px]" style={{ minWidth: 720 }}>
        <div className="flex items-center gap-3 text-xs">
          <span className="font-medium">Port</span>
          <input
            type="text"
            value={portInput}
            onChange={(e) => /^\d*$/.test(e.target.value) && setPortInput(e.target.value)}
            disabled={running || busy}
            className="px-2 py-1 rounded border bg-transparent w-24"
            style={{ borderColor: 'var(--color-border-default)' }}
            data-testid="capture-port-input"
          />
          {running ? (
            <button
              onClick={onStop}
              disabled={busy}
              className="px-3 py-1 rounded text-xs"
              style={{
                backgroundColor: 'var(--color-status-danger-background, #fee2e2)',
                color: 'var(--color-status-danger-text, #dc2626)'
              }}
              data-testid="capture-stop"
            >
              {busy ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={busy}
              className="px-3 py-1 rounded text-xs"
              style={{
                backgroundColor: 'var(--color-status-success-background, #dcfce7)',
                color: 'var(--color-status-success-text, #16a34a)'
              }}
              data-testid="capture-start"
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          )}
          {running && proxyUrl && (
            <span className="text-xs opacity-70">
              Point your app/system HTTP proxy at <code>{proxyUrl}</code>
            </span>
          )}
          <div className="flex-1" />
          <span className="font-medium">Save to</span>
          <select
            value={saveTargetUid}
            onChange={(e) => setSaveTargetUid(e.target.value)}
            className="px-2 py-1 rounded border bg-transparent text-xs"
            style={{ borderColor: 'var(--color-border-default)', maxWidth: 200 }}
            data-testid="capture-save-target"
          >
            <option value="">— pick collection —</option>
            {collections.map((c) => (
              <option key={c.uid} value={c.uid}>
                {c.name}
              </option>
            ))}
          </select>
          <button onClick={onClear} className="text-xs opacity-70 hover:opacity-100" data-testid="capture-clear">
            Clear ({events.length})
          </button>
        </div>

        <div className="text-xs opacity-70">
          Phase 3: HTTP only. HTTPS / CONNECT returns 501 — TLS interception with a minted CA lands in Phase 4.
        </div>

        <div className="flex-1 overflow-auto border rounded p-2" style={{ borderColor: 'var(--color-border-default)' }}>
          {events.length === 0 ? (
            <div className="text-xs opacity-60 text-center mt-8">
              {running
                ? 'Listening. Configure your client/system to use this proxy and traffic will appear here.'
                : 'Start the capture proxy to begin.'}
            </div>
          ) : (
            events.map((ev) => (
              <CaptureEventRow
                key={ev.id}
                event={ev}
                expanded={expandedId === ev.id}
                onToggle={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                onRemove={() => onRemove(ev.id)}
                onSave={() => onSave(ev)}
                canSave={!!saveTargetUid && !!ev.request}
              />
            ))
          )}
        </div>
      </div>
    </Modal>
  );
};

export default CapturePane;
