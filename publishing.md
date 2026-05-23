# Publishing

Postnomad is a personal fork and is **not currently published** to any package manager or distribution channel. Binaries are not signed or notarized by default; the `electron-builder-config.js` has signing disabled (`identity: null`) and notarization uses environment variables (`APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`) when present.

If you want to build a local desktop binary for yourself:

```bash
npm run build:electron:mac     # or :win / :linux / :deb / :rpm / :snap
```

See `scripts/build-electron.sh` for the underlying invocations.

If you want to fork Postnomad and publish your own variant, please rename the app and `appId` (`com.postnomad.app`) so installers don't collide with mine. And please credit [Bruno](https://github.com/usebruno/bruno) — it's the project all of this is built on.
