# Postnomad

> An open-source IDE for exploring and testing APIs. Postnomad is a personal fork of [Bruno](https://github.com/usebruno/bruno) — same offline-first philosophy, plain-text `.bru` collections, git-friendly by design.

## What this is

Postnomad is a derivative of the Bruno API client maintained as a personal fork. The core idea is the same as Bruno:

- **Offline-first**: collections live as plain-text `.bru` files on your filesystem. No accounts, no cloud sync.
- **Git-friendly**: version-control your collections like any other source.
- **Cross-platform desktop app** (Electron) plus a CLI for running collections headlessly.

This fork is **not** affiliated with or endorsed by the Bruno project or Bruno Software Inc. `Bruno` is a trademark of [Anoop M D](https://www.helloanoop.com/); Postnomad does not use the Bruno name or branding.

## Development

```bash
nvm use                     # Node 22.x
npm i --legacy-peer-deps    # --legacy-peer-deps is required
npm run setup               # builds all internal packages in dependency order
npm run dev                 # rsbuild + electron concurrently
```

If `npm run setup` fails with `ENOTEMPTY` while cleaning `node_modules`, retry once — it's a filesystem race that resolves itself. For more detail see [contributing.md](contributing.md).

## Architecture

Monorepo split into a UI layer, a host layer, and shared libraries reused by both the desktop app and the CLI. See [CLAUDE.md](CLAUDE.md) for the full layout.

- `packages/bruno-app` — React 19 + Redux + Codemirror frontend, built with rsbuild
- `packages/bruno-electron` — Electron main process; owns filesystem, IPC, network, chokidar watcher
- `packages/bruno-cli` — headless CLI for CI runs
- Shared libs: `bruno-lang` (`.bru` parser), `bruno-filestore`, `bruno-schema`, `bruno-js` (script sandbox), `bruno-requests`, `bruno-query`, `bruno-converters`, `bruno-common`

The filesystem is the source of truth; chokidar syncs disk → Redux. No cloud sync, by design.

## Credit

Postnomad would not exist without [Bruno](https://github.com/usebruno/bruno). The architecture, the `.bru` format, the offline-first stance, and the bulk of the code are all from the Bruno project and its contributors. See the upstream repo for the full author list and the original vision.

## License

MIT — see [license.md](license.md). The original Bruno copyright is preserved as required by the MIT license terms.
