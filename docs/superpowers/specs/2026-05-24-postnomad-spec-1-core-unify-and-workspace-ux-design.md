# Spec 1 — Postnomad Core Unify + Workspace UX

- **Status:** Draft — ready for review
- **Date:** 2026-05-24
- **Author:** juanjaho (with Claude assistance)
- **Scope:** First of five planned specs (see "Related specs" at the bottom)

## 1. Context

Postnomad is a personal fork of [Bruno](https://github.com/usebruno/bruno) that has, across Phases 1–5 of an earlier roadmap, gained a working Proxyman-style HTTP capture stack:

- HAR import (Phase 1, commit `27bd24ae3`).
- Per-request throttle + mock-on-real (Phase 2, commit `c78dd7fe6`).
- HTTP capture proxy backend, modal UI, save-as-request (Phase 3, commits `49447ee01`, `6265c7ed8`, `19bf5e17f`).
- TLS interception with a Postnomad-minted local CA + in-app install (Phase 4, commits `75ad8225b`, `7e4097da6`, `3536aad1c`).
- Rules engine — Map Local, Map Remote, Breakpoints — with an in-memory backing store (Phase 5, commits `e0c39e60e`, `d707516a6`).

The current capture surface is a single modal opened from `Tools → Capture HTTP Traffic…`. It works, but it's a popover over Bruno — not a workspace, and captured requests aren't first-class Bruno artifacts. Rules don't survive restart. The system proxy must be configured by hand. There's no right-click context menu, no filter bar, no flow detail tabs.

This spec defines how to merge these two app surfaces — the Bruno API client and the Proxyman-style capture stack — into a single cohesive product. The merge philosophy chosen during design is the deepest one: **captured requests become real `.bru` files on the filesystem**, participating in Bruno's full lifecycle (env-var interpolation, scripts, tabs, the request editor, mock-on-real).

## 2. Goals

- **Captures are first-class Bruno requests.** A captured HTTP roundtrip lives on disk as a `.bru` file. Browsing the sidebar, opening it in a tab, sending it via Bruno's normal client — all work without any new code paths in those layers.
- **Proxyman-shaped workspace UX.** When the user is in "capture mode", they see a workspace view (toolbar, filterable flow list, detail pane, host tree, rules sidebar) — not a modal.
- **Rules persist.** Map Local / Map Remote / Breakpoint / Block / Allow all survive app restart and follow the workspace.
- **One-click ergonomics.** The Proxyman patterns that matter: right-click on a captured row → "Map Local from Response" pre-fills the rule and writes the response body to disk; ⌘R repeats the captured bytes through the proxy; ⌘E opens an editable transient copy.
- **System proxy auto-toggle.** A toggle in the capture toolbar flips the OS proxy at `127.0.0.1:<port>` and restores the previous state on disable or quit.
- **Block / Allow rule types.** Two new rule actions added on top of the existing Phase 5 rules engine.

## 3. Non-goals

The following Proxyman-adjacent features are explicitly out of scope for this spec. Each gets its own design round later:

- **Scripting** (`onRequest` / `onResponse` JS per rule) — Spec 2.
- **Side-by-side Diff tool** — Spec 3.
- **External upstream proxy configuration** — Spec 4.
- **Per-platform cert install wizards** for iOS Simulator, iOS device, Android Emulator, Android device — Spec 5. macOS auto-install already shipped in Phase 4d.
- **Project file format** (single shareable bundle of captures + rules) — revisit in Spec 5.
- **Atlantis-style mobile SDKs** — separate native-platform projects, multi-month effort.

## 4. Design

### 4.1 Data model

**Workspace structure** (additions, hidden directory bullet last):

```
<workspace>/
├── (existing collections...)
├── Live Captures/                          ← auto-created on first capture in this workspace
│   ├── bruno.json                          ← standard Bruno collection
│   ├── .postnomad-live-captures            ← marker file (presence ⇒ this is special)
│   └── 2026-05-24__12-04-32/               ← session subfolder (ISO-ish timestamp; filesystem-safe)
│       ├── _session.json                   ← session metadata
│       ├── api.example.com/                ← grouped by host
│       │   ├── 0001-GET-users.bru          ← captured request
│       │   ├── 0001-GET-users.capture.json ← sidecar with capture metadata
│       │   └── 0002-POST-users.bru
│       └── cdn.example.com/
│           └── 0003-GET-app.js.bru
└── .postnomad/                             ← per-workspace config (hidden, dot-prefixed)
    ├── rules.json                          ← Map Local / Map Remote / Breakpoint / Block / Allow
    └── prefs.json                          ← last-used port, system-proxy state, retention
```

**Naming rules:**

- Session folder: `YYYY-MM-DD__HH-MM-SS` (filesystem-safe, sortable, no colons).
- Host folder: bare hostname.
- Captured file: `<4-digit-seq>-<METHOD>-<sanitized-last-path-segment>.bru`. Per-host monotonic counter; zero-padded; path segment sanitized (`/` → `-`, alphanumeric + `-_.` only, max 40 chars).
- Sequence cap: 9999 per (session, host). Overflow spills to `9999+-METHOD-path.bru` with a one-shot warning toast.

**Why marker file instead of a `bruno.json` field:** Bruno's `bruno.json` Yup schema is `.strict().noUnknown(true)`. Adding a `postnomadKind` field would fail validation. A presence-only marker file is zero-touch on the existing parser.

**Why sidecar `.capture.json` instead of new `meta {...}` keys in `.bru`:** the `.bru` parser at `packages/bruno-lang/v2/src/bruToJson.js` uses an Ohm.js grammar with a closed set of meta keys. Unknown keys fail to parse. A sidecar is invisible to the parser, free for us to evolve, and tied to a single `.bru` (lifecycle co-managed via filename pairing).

**File shapes:**

`Live Captures/bruno.json` is a vanilla collection:

```json
{
  "version": "1",
  "name": "Live Captures",
  "type": "collection",
  "proxy": { "enabled": false }
}
```

`Live Captures/.postnomad-live-captures`:

```json
{ "kind": "live-captures", "version": 1 }
```

`<session>/_session.json`:

```json
{
  "version": 1,
  "startedAt": "2026-05-24T12:04:32Z",
  "stoppedAt": null,
  "port": 9999,
  "caFingerprint": "8f4b...",
  "captureCount": 47,
  "label": null,
  "pinned": false
}
```

Captured `0001-GET-users.bru` is a normal Bruno request. The response from the proxy is stored using the existing `examples` mechanism Bruno already supports — which the Phase 2b mock-on-real feature already understands. This produces important synergy: every captured request automatically becomes mock-able via the existing `Mock Response` dropdown in the Settings pane.

`0001-GET-users.capture.json` sidecar:

```json
{
  "version": 1,
  "captureId": "abc-uuid",
  "capturedAt": "2026-05-24T12:04:32.412Z",
  "durationMs": 342,
  "fromHttps": true,
  "appliedRule": { "id": "rule-xyz", "name": "Mock /api/users", "action": "mapLocal" },
  "originalUrl": "https://api.example.com/users",
  "captureProxyPort": 9999,
  "replayOf": null,
  "originalCaptureId": null,
  "blocked": false
}
```

`appliedRule` is a snapshot (not a reference) so historical captures stay interpretable even after the rule is edited or deleted. `replayOf` and `originalCaptureId` are populated only for Repeat-through-Proxy captures (see §4.4).

`.postnomad/rules.json`:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "rule-xyz",
      "enabled": true,
      "name": "Mock /api/users",
      "matcher": { "urlPattern": "/api/users", "method": "*" },
      "action": "mapLocal",
      "mapLocal": { "filePath": "...", "statusCode": 200, "contentType": "application/json" }
    }
  ]
}
```

`.postnomad/prefs.json`:

```json
{
  "version": 1,
  "lastUsedPort": 9999,
  "systemProxyEnabled": false,
  "previousSystemProxyState": null,
  "captureRetention": { "maxSessions": 10 }
}
```

### 4.2 Persistence pipeline

The load-bearing architectural decision is how captures stay in sync between (a) the capture proxy event stream, (b) `.bru` files on disk, (c) Redux state in the renderer. We've chosen: **IPC stream is the source of truth for live updates; disk is the source of truth for persistence; the two converge at app startup via a one-time disk scan.**

The Live Captures folder is **not chokidar-watched.** Doing so would incur an 80ms `awaitWriteFinish` latency per capture and produce 100 Redux dispatches/sec at peak — overwhelming the renderer. Instead the capture IPC stream feeds Redux directly, and a one-time scan seeds state on workspace open.

**Flow (response phase of a capture):**

```
captureServer.onCapture(event)
  ↓
ipc/capture.js handler (orchestrator)
  ├─→ persister.persistCapture(event, sessionCtx) ──→ fire-and-forget disk write
  ├─→ mainWindow.webContents.send('main:capture-event', event)         ← existing
  └─→ mainWindow.webContents.send('main:live-captures-item-added', {  ← new
         collectionUid, sessionUid, hostFolderName, item })
                                                  ↓
                                    renderer reducers add item to
                                    collections slice (sidebar tree) +
                                    capture slice (flow list)
```

**New module — `packages/bruno-electron/src/proxy/capturePersister.js`** (pure, no IPC, no Electron):

```js
class CapturePersister {
  constructor({ workspacePath }) { ... }
  async ensureLiveCapturesCollection() { /* creates bruno.json + marker, idempotent */ }
  async startSession({ port, caFingerprint }) { /* mkdir session, write _session.json */ }
  async persistCapture(event, sessionCtx) {
    // 1. compute host folder, seq number, filename
    // 2. build .bru content via bruno-filestore stringifyHttpRequest
    //    (request from event, response stored as an example named "Captured")
    // 3. build sidecar { capturedAt, durationMs, fromHttps, appliedRule, ... }
    //    captureId = event.id (the random UUID the proxy already emits)
    // 4. write .bru + sidecar via fs.promises.writeFile (tmp + rename atomic)
    // 5. return the parsed Bruno item shape for renderer, with the sidecar
    //    data attached as `item.captureMeta` (see below)
  }
  async replayCapture(request) {
    // re-fire identical bytes through the running proxy (§4.4)
  }
  async stopSession(sessionCtx, { captureCount }) {
    /* update _session.json with stoppedAt + finalCount */
  }
}
```

**Item shape returned to renderer.** The parsed Bruno item is the standard shape (`{ uid, type: 'http-request', name, pathname, request: {...} }`) PLUS one Postnomad-only field:

```js
item.captureMeta = {
  captureId,
  capturedAt,
  durationMs,
  fromHttps,
  appliedRule,
  originalUrl,
  captureProxyPort,
  replayOf,
  originalCaptureId,
  blocked
};
```

`captureMeta` is the in-memory mirror of the on-disk `.capture.json` sidecar. The Bruno tree reducer ignores unknown item fields, so this passes through cleanly without schema changes. UI code that needs sidecar info (Detail Pane → Replay tab, rule-applied dot, blocked badge) reads `item.captureMeta?.X`. Items loaded from disk on workspace open get `captureMeta` populated by the initial-load IPC handler reading the sidecar.

**Throughput strategy — two-tier:**

- **Flow list** (`capture.events`): immediate per-event dispatch. Already capped at MAX_EVENTS=500 and the list is virtualized (`react-virtuoso`, already a project dep). No change.
- **Sidebar tree** (`collections` slice): batched. New middleware coalesces `liveCapturesItemAdded` events into a single `liveCapturesItemsBatched` dispatch every **250ms or 50 items**, whichever comes first. 100 req/sec → ~4 dispatches/sec instead of 100. Reconcile cost drops by ~25×.

Middleware location: `packages/bruno-app/src/providers/ReduxStore/middlewares/capture-batch/middleware.js`.

**Disk write strategy:**

- Async, fire-and-forget from the orchestrator. Errors logged + emitted as `main:live-captures-persist-error` toast event.
- Atomic-ish: write to `<pathname>.tmp` then `fs.rename` → atomic on POSIX, near-atomic on Windows.
- No fsync. Captures are transient enough that loss of the last few on crash is acceptable. Better latency.
- Parallelism: writes don't serialize; each capture's write runs concurrently with the next capture's processing.

**Initial load (eager, on workspace open):**

When `useIpcEvents` receives `main:workspace-opened`:

1. Dispatch `loadLiveCapturesCollection(workspacePath)` thunk.
2. Thunk invokes `renderer:load-live-captures` IPC.
3. Main scans `<workspace>/Live Captures/` recursively, parses each `.bru` via bruno-filestore, reads each `.capture.json` sidecar, builds the items tree.
4. Returns tree → reducer bulk-inserts via `liveCapturesCollectionLoaded`.

Cost: O(n) parse where n = total captured files in workspace. ~3–5s for ~10k captures, measured against bruno-filestore's current performance. If it becomes a bottleneck, fall back to lazy-load-per-session in a polish pass.

**Tradeoffs accepted:**

- External edits to the Live Captures folder (user deletes files in Finder) won't reflect until app restart. The folder is "ours" — documented behavior.
- Race between IPC item-added event and disk write completion: renderer adds the item before file finishes writing. Mitigated by deterministic pathnames computed before write; if user does "Open in Finder" within ~1ms there's a brief failure window. Imperceptible in practice.

### 4.3 Capture workspace view

**View-precedence rules.** The main area renders one of three things, in this priority order:

1. **Active tab** → existing `RequestTabPanel` (untouched). Tabs always win.
2. **Capture workspace view** (new) → when no tab is active AND the Live Captures collection is currently selected in the sidebar.
3. **Home / welcome** (existing) → fallback.

Triggers for capture workspace view to appear:

- User clicks the Live Captures collection in the sidebar.
- User clicks `Tools → Capture HTTP Traffic…` (the existing menu entry, repurposed — it selects Live Captures and closes any active tab).

This keeps Bruno's existing tabs primitive untouched and avoids inventing a parallel "modal lifecycle". The current `CapturePane` modal gets refactored into a non-modal page component and gets dropped from the page-shell mount. Its state stays in the same Redux slice.

**Layout within the main area (two columns, resizable splitter):**

```
┌──── main area when capture workspace is active ────────────────────┐
│ ┌─ Capture toolbar ────────────────────────────────────────────┐   │
│ │ ⏺ :9999 · session 2026-05-24 12:04 · 47 captures · 3 hosts  │   │
│ │ [Start|Stop] [Pause] [Clear] [⚡ sys-proxy] [New Session]    │   │
│ └──────────────────────────────────────────────────────────────┘   │
│ ┌─ Filter bar ─────────────────────────────────────────────────┐   │
│ │ ⌕ host:api method:POST  [GET POST PUT DEL][2xx 3xx 4xx 5xx]│   │
│ └──────────────────────────────────────────────────────────────┘   │
│ ┌── flow list (60%) ────┬── detail pane (40%) ──────────────────┐  │
│ │ 12:04 GET  /me   200 │ ┌ Headers · Body · Trace · Mock · ⤴ ┐ │  │
│ │ 12:04 POST /…    201 │ │                                  │ │  │
│ │ 12:05 GET  /img  …   │ │  (selected flow's detail)        │ │  │
│ │ ▶ 12:05 POST /api  ◷ │ │                                  │ │  │
│ │ 12:06 DEL  /x    204 │ │                                  │ │  │
│ └──────────────────────┴──────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

Component split:

- `pages/Bruno/CaptureWorkspace/index.js` — top-level, conditionally rendered per precedence rule.
- `pages/Bruno/CaptureWorkspace/Toolbar.js`
- `pages/Bruno/CaptureWorkspace/FilterBar.js`
- `pages/Bruno/CaptureWorkspace/FlowList.js` (uses `react-virtuoso`; sustains 10k+ rows).
- `pages/Bruno/CaptureWorkspace/DetailPane/index.js` + sub-tab components.

**Toolbar contents** (left → right):

- Status indicator: `⏺ :9999` (red dot when recording, gray when stopped). Click → opens port/CA settings popover.
- Session label: `session 2026-05-24 12:04 · 47 captures · 3 hosts`. Click → renames session (writes to `_session.json`).
- Start / Stop button — primary action, color-coded.
- Pause toggle — proxy still forwards traffic transparently, but events don't append to the flow list or write to disk.
- Clear — deletes current session from disk and state (confirm dialog).
- System proxy toggle (§4.6).
- New Session — stops current, starts a new session subfolder.

**Filter bar.** Single text input with typed-operator parsing: `host:` `method:` `status:` `url:` `header:` `body:` `rule:` (matches `appliedRule.name`). Each operator is `key:value` or `key:"quoted value"`. Multiple operators AND-ed. Free text without operator = url-substring search. Method chips and status-class chips (2xx/3xx/4xx/5xx) with count badges. All filtering renderer-side.

**Flow list rows** show, left → right: time (HH:MM:SS, gray), method badge (color-coded per method), status badge (color-coded per status class, spinner if response pending), host (truncated, gray), path (highlighted on filter match), duration (right-aligned), applied-rule dot (small colored circle if a rule fired, color per action type).

Hover state reveals action icons on the right:

- ⤴ Repeat
- ↗ Open in Editor (= double-click)
- ⋮ More menu (full context menu)

Single-click selects the row and populates detail pane. Double-click opens it in a tab. Cmd-click multi-selects (wired but bulk operations land in later specs).

**Detail pane tabs:**

- **Headers** — request + response headers in stacked panels. Sortable. Copy-button per header.
- **Body** — Pretty / Raw / Hex / Preview sub-modes. Pretty auto-detects JSON / XML / form / HTML / image. Preview renders images and HTML inline.
- **Trace** — timeline strip of the request lifecycle (DNS, connect, TLS handshake, request sent, response received, body downloaded). Pulled from existing `response.timeline`.
- **Mock** — shows applied rule if any, plus a button "Create Map Local from this response" that one-shots the rule + file write described in §4.4.
- **Replay** — history of Repeats fired against this exact captured request, each as a sub-row.

Header strip carries the same `⤴ Repeat`, `↗ Open in Editor`, `⋮ More` action icons.

**Right-click context menu** on flow list rows (uses Bruno's existing `MenuDropdown` component with `onContextMenu` handler — no new library):

- Open in Editor (default for double-click)
- Repeat through Proxy
- Edit & Repeat
- Compose Similar
- _(divider)_
- Map Local from Response
- Add Map Remote rule
- Add Breakpoint
- Add to Block List
- Add to Allow List
- _(divider)_
- Copy as cURL
- Save to Collection… (move to a real Bruno collection)
- Delete

**Sidebar additions.** A new collapsible section at the bottom of the existing sidebar (sibling to Collections and ApiSpecs): **Rules.** Five sub-sections (Map Local / Map Remote / Breakpoint / Block / Allow), each with: count badge, enable-toggle for the whole category, list of individual rules, "+ Add rule" inline button. Clicking an individual rule opens an inline rule editor modal via the existing `Portal` pattern. Visible regardless of which collection is selected — rules are workspace-scoped.

**Redux additions:**

- `capture` slice: add `filter` (text + chip state), `selectedFlowId`, `currentSessionUid`, `paused` boolean. Move events to a virtualized-friendly Map keyed by id.
- `collections` slice: actions from §4.2 (`liveCapturesCollectionLoaded`, `liveCapturesItemAdded`, `liveCapturesSessionStarted`). No structural changes.
- `captureUi` slice (or fold into `capture`): `splitterPosition`, `detailPaneTab`, `flowListColumnWidths` — persisted to localStorage via existing pattern.

### 4.4 Editor bridge — five entry points

| Action                                           | What happens                                                                                                          | Key implementation                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Open in Editor** (double-click / context menu) | Opens captured `.bru` in a tab via existing `addTab`. Send goes through Bruno's normal client. Pristine until edited. | Pure `addTab` dispatch. No new code.                                       |
| **Repeat through Proxy** (⌘R)                    | Re-fires the captured request's exact bytes through the capture proxy. New entry in flow list.                        | New IPC `renderer:capture-repeat`, new `capturePersister.replayCapture()`. |
| **Edit & Repeat** (⌘E)                           | Copies captured `.bru` to transient dir, opens as a transient tab, Send goes through normal client.                   | Bruno's existing `isTransient` pattern. New thunk.                         |
| **Compose Similar** (⌘D)                         | Same as Edit & Repeat but URL path cleared to `/` and body emptied. Headers (esp. auth) preserved. Same method.       | Same thunk, with a "blank out" pass.                                       |
| **Compose New** (⌘N)                             | Empty transient request in Live Captures. Pre-populates URL to `https://`.                                            | Bruno's existing transient flow with a Live-Captures-specific target.      |

**Open in Editor — pristine-until-edited:**

- `addTab({ uid, collectionUid: liveCapturesCollectionUid, pathname, type: 'request', itemUid })`.
- Existing `RequestTabPanel` → `HttpRequestPane` renders the captured request like any other Bruno request.
- The captured `.bru` stays pristine on disk until the user edits. Bruno already has per-tab draft state (`item.draft` vs `item.request`). Edits go to draft. The user-facing "save" only mutates the file on explicit save.
- Many users will Open → Send → never edit. Disk file unchanged. Re-firing produces consistent results.

**Send semantics:**

- Goes through Bruno's normal `send-http-request` IPC → `network/index.js` → axios. **Not** through the capture proxy.
- Env-var interpolation, pre-request scripts, auth substitution, custom headers, tests — all of Bruno's request lifecycle applies. This is the unify payoff.
- Env context for captured requests is opt-in. Default: no env. Editor surfaces a small selector at the top of the captured tab: `Send using env from: (none) ▾` — dropdown lists all collections + their envs in the workspace. User picks. State persisted per-tab.
- Result lands in the response pane as normal. Does NOT get added to the capture flow list (Bruno-side request, not proxy-captured).

This is the cleanest separation: **Send = Bruno-side replay** (env-aware, script-aware); **Repeat through Proxy = wire-level replay** (exact bytes).

**Repeat through Proxy:**

New IPC `renderer:capture-repeat`. Input: `{ capturedItemPathname }`. Main reads the `.bru` + sidecar, reconstructs the original request, calls `CaptureServer.replayCapture()` — same internal forwarder used by `_proxyRequest`, just bypassing the "I received this from a client socket" entry path. Builds the axios-like upstream request with the same hop-header stripping + scheme handling. Response comes back through the existing capture pipeline (onCapture event → persister → renderer). Emits with `replayOf: <originalCaptureId>` in the sidecar.

**Edit & Repeat — transient pattern reuse:**

Bruno already has the building blocks. Thunk `editAndRepeatCapture(capturedItem)`:

1. Ensure transient dir for Live Captures collection (`addTransientDirectory`).
2. Generate a transient filename: `<originalName>-edit-<short-uid>.bru`.
3. `newHttpRequest({ requestName, filename, isTransient: true, collectionUid: liveCapturesCollectionUid, headers, body, auth, requestUrl, requestMethod, ... })` — pre-populated from `capturedItem.request`.
4. The transient `.bru` is written, chokidar fires (it watches Bruno collections — including Live Captures' transient subdir), tab opens automatically.
5. User edits, hits Send — goes via normal client.
6. On tab close OR app close: transient `.bru` is deleted (existing Bruno cleanup).

If user wants to keep the edited version, they hit "Save As" → `renderer:save-transient-request`'d to a target collection.

**Compose Similar** is the same thunk with one extra step before step 3: blank out the URL path (`new URL(url).origin + '/'`) and the body, keep headers (auth + content-type especially) and method.

**Compose New** uses the existing transient flow with empty fields.

**Replay correlation:**

- Sidecar's `replayOf` field is set on Repeat-through-Proxy captures.
- Detail Pane → Replay tab queries `state.collections.items.where(i => i.captureMeta?.replayOf === currentItem.captureMeta?.captureId)`.
- Replay rows show: timestamp, status code, duration delta vs original. Click to navigate.
- Multi-hop replay chains share the same `originalCaptureId` (stored alongside immediate `replayOf`).

**Keyboard shortcuts** (registered in `packages/bruno-app/src/providers/Hotkeys/keyMappings.js`):

| Key | Action                               | Active when                                                  |
| --- | ------------------------------------ | ------------------------------------------------------------ |
| ⌘N  | Compose New                          | Capture workspace visible OR Live Captures collection active |
| ⌘R  | Repeat through Proxy (selected flow) | Capture workspace visible AND a flow is selected             |
| ⌘E  | Edit & Repeat (selected flow)        | Same                                                         |
| ⌘D  | Compose Similar (selected flow)      | Same; if conflicts with Bruno's existing ⌘D, move to ⌘⇧E     |
| ⌘F  | Focus filter input                   | Capture workspace visible                                    |
| ⌘⇧K | Clear current session                | Capture workspace visible (confirm dialog)                   |
| Esc | Deselect current flow                | Capture workspace visible                                    |

Shortcuts are scoped to the capture workspace visibility so they don't conflict with Bruno's existing ⌘N (new request in collection).

**Code organization** (new files):

- `packages/bruno-app/src/providers/ReduxStore/slices/capture/actions.js` — five action thunks (open, repeat, editAndRepeat, composeSimilar, composeNew).
- `packages/bruno-electron/src/proxy/capturePersister.js` — `replayCapture()` method added.
- `packages/bruno-electron/src/ipc/capture.js` — new handler `renderer:capture-repeat`.
- `packages/bruno-electron/src/proxy/captureServer.js` — new method `replayCapture(request)`.

No changes to: Bruno's tab system, `HttpRequestPane` / response rendering, `send-http-request` IPC or `runRequest` in `network/index.js` (except adding a tiny "request originated from replay" flag if useful for logging).

### 4.5 Rules persistence + Block / Allow

**Extended rule schema** (versioned envelope):

```json
{
  "version": 1,
  "rules": [
    {
      "id": "rule-xyz",
      "enabled": true,
      "name": "Mock /api/users",
      "matcher": { "urlPattern": "/api/users", "method": "*" },
      "action": "mapLocal",
      "mapLocal": { "filePath": "...", "statusCode": 200, "contentType": "application/json" }
    },
    {
      "id": "rule-blk",
      "enabled": true,
      "name": "Block analytics",
      "matcher": { "urlPattern": "/^https://.*\\.analytics\\..*/", "method": "*" },
      "action": "block",
      "block": { "statusCode": 502, "body": "Blocked by Postnomad", "headers": {} }
    },
    {
      "id": "rule-aw",
      "enabled": true,
      "name": "Only capture api.example.com",
      "matcher": { "urlPattern": "api.example.com", "method": "*" },
      "action": "allow"
    }
  ]
}
```

`block.body`, `block.headers`, `block.statusCode` optional with defaults (502 / `Blocked by Postnomad` / `{}`). `allow` has no config — the matcher is the whole story.

**Action semantics:**

| Action       | Proxy behavior on match                                    | Proxy behavior on non-match |
| ------------ | ---------------------------------------------------------- | --------------------------- |
| `mapLocal`   | Synthesize response from file, capture                     | Forward, capture            |
| `mapRemote`  | Rewrite target, forward, capture                           | Forward, capture            |
| `breakpoint` | Pause, await user, forward (edited), capture               | Forward, capture            |
| `block`      | Return configured error, emit "blocked" event, no upstream | Forward, capture            |
| `allow`      | Forward, capture                                           | Forward, **do NOT capture** |

**Rule evaluation order:** top-to-bottom in the rules array. First non-allow rule that matches wins (mapLocal / mapRemote / breakpoint / block are mutually exclusive per request — first one short-circuits).

**Allow rules are evaluated as a pre-filter:**

- If any `allow` rule exists AND no `allow` rule matches → the request is forwarded transparently AND not captured.
- If no `allow` rules exist → every request is captured (today's behavior).
- If at least one `allow` matches → request enters the normal pipeline (then other rules apply).

**Block-specific behavior:**

- Default response: `502 Bad Gateway`, `Content-Type: text/plain`, body `Blocked by Postnomad` + rule name.
- Block events DO appear in the capture flow list (red "BLOCKED" badge) so the user can see what's being blocked. Sidecar records `blocked: true`. `.bru` is written so the request can be inspected.
- Optional per-rule `block.silent: true` opt-out hides them from the flow list (still forwarded as error to client). Useful for ad-blocker-style high-volume scenarios.

**Persistence pipeline (rules):**

```
[user edits a rule in UI]
  ↓ dispatch addRule / updateRule / removeRule
[capture slice updates]
  ↓ subscribed middleware (debounced 500ms)
[Redux middleware: save-rules-to-disk]
  ├─→ ipc.invoke('renderer:save-workspace-rules', { workspacePath, rules })
  │     → fs.writeFile <workspace>/.postnomad/rules.json (atomic tmp+rename)
  └─→ ipc.invoke('renderer:capture-set-rules', rules)
        → proxy hot-swaps active rules
```

Two IPC calls because they're independent: disk write can fail without affecting in-memory proxy state, and vice versa.

**Load pipeline (rules):**

On `main:workspace-opened`:

1. Renderer dispatches `loadWorkspaceRules(workspacePath)` thunk.
2. Thunk invokes `renderer:load-workspace-rules` IPC.
3. Main reads `<workspace>/.postnomad/rules.json`. Missing file → returns `{ version: 1, rules: [] }`. Malformed JSON → returns empty + emits error toast event.
4. Renderer reducer replaces `state.capture.rules` (authoritative load).
5. Subscribed middleware sees the state change and pushes to proxy via `renderer:capture-set-rules`.

On workspace switch: save current workspace's rules to disk (forced flush of debounce) THEN load the new workspace's rules.

**New IPC channels:**

| Channel                         | Direction     | Payload                             |
| ------------------------------- | ------------- | ----------------------------------- |
| `renderer:save-workspace-rules` | renderer→main | `{ workspacePath, rules }`          |
| `renderer:load-workspace-rules` | renderer→main | `{ workspacePath }` → `{ rules[] }` |

`renderer:capture-set-rules` already exists from Phase 5a.

**Backend changes (captureServer.js):**

1. Allow pre-filter at the top of `_proxyRequest`: check `this._allowRulesPresent && !this._anyAllowMatches(url, method)` → call slim "passthrough" path that forwards without capturing. Memoize `_allowRulesPresent` to avoid recomputing per request.
2. New `_handleBlock(req, res, rule, capturedUrl)` method mirrors `_handleMapLocal` in shape.
3. Rule precedence: `findMatchingRule` already returns first match. Add `'block'` to the dispatch switch.

**Rule editor UI** (modal triggered from sidebar or right-click). Form structure: name, enabled toggle, URL pattern, method dropdown, action selector, action-specific sub-form. URL pattern field shows a small "matches: 3 of 47 current captures" preview chip — runs the matcher against the active session's flows in real time.

### 4.6 System proxy auto-toggle

**Per-platform implementation** (pattern from Phase 4d trust install):

- **macOS** (full support): `networksetup -listallnetworkservices` to enumerate active services. Apply per service via `-setwebproxy "<service>" 127.0.0.1 <port>` and `-setsecurewebproxy`. Both require admin → wrapped in one `osascript … with administrator privileges` call. Read current state via `-getwebproxy`. Disable via `-setwebproxystate off` and `-setsecurewebproxystate off`. Bypass list untouched.
- **Windows** (best-effort, no admin): registry write to `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyEnable` + `ProxyServer`. Broadcast `WM_SETTINGCHANGE` via `RUNDLL32.EXE wininet.dll,InternetSetOption ... NULL 0` so live apps notice. v1 ships behind a feature flag with a "macOS only for v1" toast on Windows.
- **Linux** (best-effort): detect `$XDG_CURRENT_DESKTOP`. GNOME → `gsettings set org.gnome.system.proxy …`. KDE → `kwriteconfig5`. Fallback → write a `~/.bashrc.postnomad` env-var file. Same v1 feature-flag policy.

**State tracking** in `.postnomad/prefs.json`:

```json
{
  "systemProxyEnabled": true,
  "systemProxyPort": 9999,
  "previousState": {
    "platform": "darwin",
    "savedAt": "2026-05-24T12:04:32Z",
    "services": [
      { "name": "Wi-Fi", "http": { "enabled": false, "host": "", "port": 0 }, "https": { ... } },
      { "name": "Ethernet", "http": { ... }, "https": { ... } }
    ]
  }
}
```

`previousState` captured at toggle-on, used for exact restore.

**IPC channels:**

| Channel                         | Direction     | Payload                                                   |
| ------------------------------- | ------------- | --------------------------------------------------------- |
| `renderer:system-proxy-status`  | renderer→main | → `{ enabled, pointingAtUs, currentHostPort, supported }` |
| `renderer:system-proxy-enable`  | renderer→main | `{ port }` — saves previous state, applies our proxy      |
| `renderer:system-proxy-disable` | renderer→main | → restores previous state                                 |

**Three-state toolbar toggle:**

- **Off** (gray) — system proxy off OR pointing elsewhere. Click to enable.
- **On, pointing at us** (green) — we own it. Click to disable.
- **On, pointing elsewhere** (amber) — system proxy is on, pointing at another address. Click shows a warning modal explaining the conflict; enabling overrides.

Click handlers:

- Off → On: confirmation dialog with macOS admin-prompt warning → `renderer:system-proxy-enable` → toast + visual flip.
- On (ours) → Off: instant disable, no confirmation.
- On (elsewhere) → On (ours): stronger confirmation: "This will replace your existing proxy `<host:port>` with Postnomad. Restored on disable."

**Auto-cleanup on app quit:** Electron's `before-quit` hook. Check `state.capture.systemProxyEnabled` AND current OS proxy actually points at us → fire `system-proxy.disable()` synchronously. Skip the prompt if user already toggled off cleanly. Show a 5-second visual warning before quit when an admin prompt will fire.

**Recovery on launch:**

- If `systemProxyEnabled: true` AND current OS proxy points at us → all good.
- If `systemProxyEnabled: true` AND OS proxy points elsewhere → external change, update state, show toast.
- If `systemProxyEnabled: false` AND OS proxy points at us → orphan from prior crash, offer to restore previous state.

**Security copy** near the toggle: "Routes all HTTP/HTTPS through Postnomad. CA must be trusted for HTTPS to decrypt without errors." Toast if user enables without CA trusted.

**Code organization:**

- `packages/bruno-electron/src/proxy/system-proxy.js`
- `packages/bruno-electron/src/proxy/system-proxy.spec.js` (helpers only; actual `networksetup` stubbed)
- IPC handlers added to `packages/bruno-electron/src/ipc/capture.js`
- UI changes in `pages/Bruno/CaptureWorkspace/Toolbar.js`

## 5. Implementation phasing

Twelve commits, ordered for incremental shippability. After commits 1–3 the user can do meaningful work; after 4 rules survive restart; after 5–8 the Proxyman feel lands.

| #   | Commit                                                                                    | Effort |
| --- | ----------------------------------------------------------------------------------------- | ------ |
| 1   | `feat: capture persister — write .bru + sidecar to Live Captures folder`                  | 1 day  |
| 2   | `feat: Live Captures collection auto-loads on workspace open`                             | 1 day  |
| 3   | `feat: captured request bridge — env selector, send through Bruno client`                 | 1 day  |
| 4   | `feat: workspace-scoped rules.json + load/save IPC + middleware`                          | ½ day  |
| 5   | `feat: Block + Allow rule actions`                                                        | ½ day  |
| 6   | `refactor: capture workspace view replaces modal — 3-region layout`                       | 2 days |
| 7   | `feat: filter bar + typed operators + method/status chips`                                | 1 day  |
| 8   | `feat: right-click context menu + Repeat-through-Proxy + Edit & Repeat + Compose Similar` | 2 days |
| 9   | `feat: capture keyboard shortcuts — ⌘N / ⌘R / ⌘E / ⌘D / ⌘F / ⌘⇧K / Esc`                   | ½ day  |
| 10  | `feat: system proxy auto-toggle (macOS)`                                                  | 2 days |
| 11  | `feat: capture session cap + retention policy`                                            | ½ day  |
| 12  | `feat: capture pane settings — port, CA panel, retention, scripting-stub`                 | 1 day  |

**Total:** ~12 working days for a single developer pushing hard. ~3 calendar weeks at a sustainable pace. ~3.5 weeks elapsed with buffer for review cycles.

**Parallelizable splits** if multiple developers:

- Commits 1, 4, 10 can be worked in parallel branches (no overlap).
- Commits 2, 3 sequential after 1.
- Commit 5 sequential after 4.
- Commits 6, 7, 8, 9 sequential (each builds on prior UI state).
- Commits 11, 12 sequential after 8.

Optimal parallelism with two devs: ~2 calendar weeks.

**Acceptance gates per commit:**

- Full repo `npm run lint` clean.
- `npm test --workspaces --if-present` no regressions.
- `npm run build:web` succeeds (bundle baseline ~17.7 MB; alert if any single commit adds >50 KB).
- Per-commit tests as listed in the design.
- Manual verification step in the commit message.

**Phase-out notes:**

- Current `CapturePane` modal (`components/CapturePane/index.js`) is fully replaced by commit 6. The component file is removed; logic moves to `pages/Bruno/CaptureWorkspace/`.
- Current in-memory rules in `state.capture.rules` continue working through commit 4 unchanged; commit 4 adds disk-load on workspace open and disk-save on change.
- `BreakpointModal` survives unchanged.

## 6. Test strategy

**Unit tests (Jest), per package:**

- `packages/bruno-electron/src/proxy/capturePersister.spec.js`: mkdtemp, instantiate persister, simulate 50 capture events across 3 hosts, assert tree structure, file contents, sidecar fields, seq numbering, session.json finalization.
- `packages/bruno-electron/src/proxy/captureServer.spec.js`: extend with Block + Allow cases (Block returns configured error + emits "blocked" event; Allow filters captures correctly; Block overrides Allow; multi-rule precedence).
- `packages/bruno-electron/src/proxy/system-proxy.spec.js`: command construction + output parsing (actual `networksetup` calls stubbed).
- `packages/bruno-app/src/providers/ReduxStore/middlewares/capture-batch/middleware.spec.js`: fire 100 single-item actions in 100ms, assert exactly one batched dispatch.
- `packages/bruno-app/src/providers/ReduxStore/slices/capture/actions.spec.js`: five action thunks dispatch correct sub-actions.

**Integration tests:**

- `captureServer.spec.js` E2E: wire persister to a real server, do 5 HTTP roundtrips through the proxy, assert files on disk match the events.
- Rules round-trip: load malformed `rules.json` → empty rules + toast; edit → save → restart → load → present.
- System proxy round-trip (macOS only, CI-skipped): enable → verify Safari shows captures via proxy → disable → verify restored.

**Renderer tests** (React Testing Library):

- Capture workspace view mounts when Live Captures selected + no tab; doesn't mount when tab is active.
- Filter bar typed-operator parsing + chip filtering.
- Right-click menu shows correct items for HTTP vs HTTPS vs blocked captures.

**Playwright E2E (existing test suite):**

- New spec `tests/capture/*.spec.ts` covering: capture → see in sidebar → open in tab → send via Bruno client → repeat through proxy.

## 7. Known risks / open questions

- **Renderer performance under sustained 100 req/sec capture** is mitigated by the 250ms / 50-item batch window but not validated until commit 6 lands. If still laggy, options: lower MAX_EVENTS in the flow list (currently 500), increase batch window, virtualize the sidebar tree (Bruno's current tree is not virtualized).
- **Chokidar interaction with Live Captures' transient subdir** (used by Edit & Repeat). The transient dir IS chokidar-watched (since it's a normal Bruno temp dir pattern), but it lives under the Live Captures folder which we said isn't watched. Resolution: chokidar watches START at the transient dir specifically, not the Live Captures parent. Confirmed by reading `addTransientDirectory` in `slices/collections/index.js:3587`.
- **Disk space** for heavy capture sessions. Mitigated by §5 commit 11 retention. Default 10 sessions cap; pinned sessions exempt.
- **macOS admin-prompt UX cost** for system proxy. Two prompts per capture session in the common case (enable + quit-restore). Documented; acceptable per design.
- **rules.json concurrent edit** (two Postnomad instances open on the same workspace) clobbers each other. Acceptable — workspaces are single-instance in practice.

## 8. Out of scope (explicitly deferred)

| Feature                                                    | Deferred to                           |
| ---------------------------------------------------------- | ------------------------------------- |
| JS scripting (`onRequest` / `onResponse` per rule)         | Spec 2                                |
| Side-by-side Diff tool                                     | Spec 3                                |
| External upstream proxy config                             | Spec 4                                |
| Per-platform cert install wizards (iOS / Android)          | Spec 5                                |
| Project file format (shareable bundle of captures + rules) | Spec 5                                |
| Mobile SDK (Atlantis-style iOS/Android)                    | Separate native projects, multi-month |
| PAC script generation                                      | Out of roadmap                        |
| Per-app proxy assignment via Network Extensions on macOS   | Out of roadmap                        |

## 9. Related specs

| #   | Status      | Title                                                   |
| --- | ----------- | ------------------------------------------------------- |
| 1   | This spec   | Core Unify + Workspace UX                               |
| 2   | Not started | Scripting engine                                        |
| 3   | Not started | Diff tool                                               |
| 4   | Not started | External upstream proxy                                 |
| 5   | Not started | Per-platform cert install wizards + project file format |
