import React, { useState, useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Modal from 'components/Modal';
import { resolveBreakpoint } from 'providers/ReduxStore/slices/capture';
import toast from 'react-hot-toast';

/**
 * Phase 5b — breakpoint editor modal.
 *
 * Pops automatically whenever the capture proxy has paused at least one
 * request awaiting user action. Shows ONE breakpoint at a time (the
 * head of the queue); user clicks Forward or Cancel, then the next one
 * (if any) becomes the head.
 *
 * Edits supported in this MVP: body text + headers (as JSON). URL /
 * method edits live in Phase 5c — sending an edited URL through the
 * existing socket needs more plumbing on the proxy side.
 */
const BreakpointModal = () => {
  const dispatch = useDispatch();
  const pending = useSelector((state) => state.capture.pendingBreakpoints);
  const head = pending && pending.length ? pending[0] : null;

  const [bodyEdit, setBodyEdit] = useState('');
  const [headersEdit, setHeadersEdit] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the editors whenever the head breakpoint changes. Keyed on
  // head?.id only; the rest of head is read inside the effect.
  const headId = head?.id;
  useEffect(() => {
    if (!head) return;
    setBodyEdit(head.request?.body || '');
    setHeadersEdit(JSON.stringify(head.request?.headers || {}, null, 2));
    setBusy(false);
    // We intentionally don't depend on `head` itself — only on its id.
  }, [headId, head]);

  const parsedHeaders = useMemo(() => {
    if (!headersEdit.trim()) return { ok: true, value: {} };
    try {
      const value = JSON.parse(headersEdit);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { ok: true, value };
      }
      return { ok: false, error: 'must be a JSON object' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, [headersEdit]);

  if (!head) return null;

  const resolve = async (action, edited) => {
    setBusy(true);
    try {
      await window.ipcRenderer.invoke('renderer:capture-breakpoint-resolve', { id: head.id, action, edited });
    } catch (err) {
      toast.error(err.message || 'Could not resolve breakpoint');
    } finally {
      dispatch(resolveBreakpoint(head.id));
      setBusy(false);
    }
  };

  const onForward = () => {
    const edited = {};
    if (bodyEdit !== (head.request?.body || '')) edited.body = bodyEdit;
    if (parsedHeaders.ok) {
      // Only forward headers if changed from the captured set.
      const original = JSON.stringify(head.request?.headers || {}, null, 2);
      if (headersEdit !== original) edited.headers = parsedHeaders.value;
    }
    resolve('forward', edited);
  };

  return (
    <Modal
      size="lg"
      title={`Breakpoint — ${head.request?.method || 'GET'} ${head.url || ''}`}
      hideFooter
      handleCancel={() => resolve('cancel')}
    >
      <div className="flex flex-col gap-3 text-xs" style={{ minWidth: 720 }} data-testid="breakpoint-modal">
        <div className="opacity-80">
          The proxy is holding this request. Edit body or headers below, then click Forward to send (or Cancel to drop).{' '}
          {pending.length > 1 && <span>· {pending.length - 1} more queued</span>}
        </div>

        <div>
          <div className="font-semibold mb-1">Request</div>
          <div className="opacity-70 mb-1">
            <span className="font-mono">{head.request?.method}</span>{' '}
            <span className="font-mono">{head.url || head.request?.url}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3" style={{ minHeight: 340 }}>
          <div className="flex flex-col">
            <label className="font-semibold mb-1">Headers (JSON)</label>
            <textarea
              value={headersEdit}
              onChange={(e) => setHeadersEdit(e.target.value)}
              className="flex-1 px-2 py-1 rounded border bg-transparent font-mono text-xs"
              style={{
                borderColor: parsedHeaders.ok ? 'var(--color-border-default)' : 'var(--color-status-danger-text)'
              }}
              spellCheck={false}
              data-testid="breakpoint-headers"
            />
            {!parsedHeaders.ok && (
              <div className="mt-1" style={{ color: 'var(--color-status-danger-text)' }}>
                {parsedHeaders.error}
              </div>
            )}
          </div>
          <div className="flex flex-col">
            <label className="font-semibold mb-1">Body</label>
            <textarea
              value={bodyEdit}
              onChange={(e) => setBodyEdit(e.target.value)}
              className="flex-1 px-2 py-1 rounded border bg-transparent font-mono text-xs"
              style={{ borderColor: 'var(--color-border-default)' }}
              spellCheck={false}
              data-testid="breakpoint-body"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <div className="flex-1" />
          <button
            onClick={() => resolve('cancel')}
            disabled={busy}
            className="px-3 py-1 rounded text-xs"
            style={{
              backgroundColor: 'var(--color-status-danger-background, #fee2e2)',
              color: 'var(--color-status-danger-text, #dc2626)'
            }}
            data-testid="breakpoint-cancel"
          >
            Cancel request
          </button>
          <button
            onClick={onForward}
            disabled={busy || !parsedHeaders.ok}
            className="px-3 py-1 rounded text-xs"
            style={{
              backgroundColor: 'var(--color-status-success-background, #dcfce7)',
              color: 'var(--color-status-success-text, #16a34a)'
            }}
            data-testid="breakpoint-forward"
          >
            Forward{' '}
            {bodyEdit !== (head.request?.body || '') ||
            headersEdit !== JSON.stringify(head.request?.headers || {}, null, 2)
              ? '(with edits)'
              : ''}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default BreakpointModal;
