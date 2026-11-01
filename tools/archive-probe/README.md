# Archive probe tools

Throwaway tools used to reproduce and verify the page-archive fixes on `fix/archive-recorder`. They are not part of the app. Plan and findings: [docs/plans/archive-capture.md](../../docs/plans/archive-capture.md).

## Test site

`node archive-fixture.mjs` serves a page on `http://127.0.0.1:47831/` that prints PASS or MISSING for each thing an archive has to hold:

| Check | What it needs in the WARC |
| --- | --- |
| Query alpha / Query bravo | Two POSTs to `/graphql` with different bodies, each with its own answer |
| Worker data | The worker script and the request it makes |
| Cross-site iframe | `http://localhost:47831/frame.html` plus its image and data request |

`/guarded` answers 403 with a script that sets a cookie and reloads, the way a Cloudflare managed challenge does. Stop the server before reloading a replay to prove it comes from the archive.

## Running Pond in isolation

- `launch-test-app.sh <app> <data dir> [extra args]` starts any Pond build with `POND_SANDBOX` and `--use-mock-keychain`, so it never touches the real library or keychain. Works for `/Applications/Pond.app` too. Pass `--remote-debugging-port=9333 --remote-allow-origins=http://127.0.0.1:9333` to inspect it.
- `wait-log.sh <log> <regex> <count> <seconds>` waits for pipeline lines in a sandbox's `logs/main.log`.

## Building a test copy

A test copy needs its own `appId`, or its Safari and Share extensions collide with the installed Pond's.

Sandbox-only copy (no browser extension):

1. Set `appId` and `productName` in `apps/desktop/electron-builder.yml` (for example `so.shahin.pondarchivetest` / `Pond Archive Test`).
2. `build-test-app.sh apps/desktop` builds the app and its extensions and signs it with the Developer ID in the login keychain. `rebuild-test-app.sh` skips the extension builds.
3. Restore the yml, then start it with `launch-test-app.sh`.

Safari-capable copy (its own app group, Safari socket on, own data folder and mock keychain, opens with a double-click):

1. `git apply tools/archive-probe/test-copy.patch`
2. `build-test-app.sh apps/desktop`
3. `git checkout -- apps packages` (never commit the patch's edits)
4. `NOTARY_OP_ITEM=<1Password item id> notarize-app.sh "apps/desktop/dist/mac-arm64/Pond Archive Test.app" <work dir>`. Safari only lists a Developer ID extension once the app is notarized.
5. Open the app, then turn on its "Pond" entry in Safari Settings, Extensions (and turn off the regular Pond extension while testing).

Data lives in `dist/mac-arm64/Pond Archive Test Data`. The Chrome native socket fails to bind there (path over the macOS socket length limit); that is expected, Chrome keeps talking to the regular Pond.

Cleanup: quit the app, `pluginkit -r` both `.appex` bundles in `Contents/PlugIns`, `lsregister -u` the app, then delete `dist/`, `out/`, `.safari-build/`, `.share-build/`, `resources/{Safari,Share}Extension/`, `resources/bin/pond-{apple-model,native-host}` and `~/Library/Group Containers/89S32876QM.so.shahin.pondarchivetest`.

## Debugging

- `warc-summary.mjs <warcio dist/index.js> <archive.warc.gz>` lists every record: type, method or status, URL, size.
- `oopif-probe.mjs <Chrome binary>` shows which responses a page-level CDP session sees with and without `Target.setAutoAttach`.
- `inspect-replay.mjs <port>`, `replay-eval.mjs <port> <expression>` and `reload-iframe.mjs <port>` look inside the archive viewer's webview (frame tree, fetches in the page's own context, CSP and load errors for a nested frame).
- `watch-hidden-window.mjs <port> <url part> [seconds]` reads the title and text of Pond's hidden harvest window while it loads a page. Screenshots hang on a window that is never shown.
