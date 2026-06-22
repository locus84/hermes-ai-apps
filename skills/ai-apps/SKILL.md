---
name: ai-apps
description: "Create named AI Apps: static or serverless app-in-app artifacts for the Hermes dashboard."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [ui, prototype, dashboard, static-html, iframe, ai-apps]
---

# AI Apps

Use this skill when the user asks to create a small named app-in-app artifact that should be viewable in Hermes, including:

- UI prototype / mockup / concept
- HTML/CSS one-off artifact
- dashboard/AI Apps preview
- iframe/fullscreen preview
- Korean requests such as "플레이그라운드에 넣어줘", "대시보드에서 볼 수 있게", "UI 목업 만들어줘"

The AI Apps dashboard plugin discovers named app folders and shows them as app-in-app previews with dashboard-hosted full view. A folder may be pure static HTML/CSS/JS, or it may include optional per-app Python RPC functions via `server.py`.

## App locations and names

Create new user apps under:

```text
~/.hermes/ai-apps/apps/<app-name>/
```

The plugin scans bundled/plugin-owned apps under `~/.hermes/plugins/ai-apps/dashboard/dist/apps/<app-name>/` when present, but repository examples should live under `samples/apps/<app-name>/` instead of active dashboard scan roots. Normal generated apps should live in the user app store above so removing/reinstalling the plugin does not delete them.

Canonical plugin identity is `ai-apps` everywhere: plugin folder `~/.hermes/plugins/ai-apps`, user app store `~/.hermes/ai-apps/apps`, dashboard route `/ai-apps`, API prefix `/api/plugins/ai-apps`, static prefix `/api/plugins/ai-apps/static/apps`, and JS bridge globals `AIApps` / `AI_APPS_GUID`. Do not create new `ui-playground` paths or docs; keep old `UIPlayground` / `UI_PLAYGROUND_GUID` references only as compatibility aliases for existing apps.

Use a readable slug instead of a random GUID whenever the app is easy to delete or replace.

Naming rules:

1. Use lowercase kebab-case: `inventory-cards`, `agent-console`, `rpc-counter`.
2. Let the AI choose a descriptive name when the user did not name the app.
3. For throwaway work, prefix with `temp-`: `temp-card-layout`, `temp-toolbar-v2`.
4. For durable named apps, avoid dates/random suffixes unless needed to prevent collisions.
5. Keep all files for the app inside that folder.
6. Legacy static artifacts under `dist/sessions/<name>/` may still be displayed, but new work should use `dist/apps/<app-name>/` even when there is no backend.

Required files:

```text
index.html
manifest.json
```

Optional files:

```text
style.css
app.js
assets/*
server.py        # apps only: Python RPC functions
 data/*          # apps only: per-app persisted data
```

## manifest.json schema

```json
{
  "guid": "<app-name>",
  "title": "Human-readable app title",
  "description": "Short description",
  "created_at": "ISO timestamp",
  "author": "hermes-session",
  "entry": "index.html",
  "tags": ["app", "ui"]
}
```

`guid` is kept for compatibility with the plugin API, but it should normally equal the folder/app name rather than a random UUID.

Rules:

1. `entry` is relative to the app folder. Use `index.html` unless there is a reason not to.
2. Use relative asset paths such as `./style.css` or `assets/icon.svg`.
3. Do not require a dev server. The app must open as a static browser page; backend logic, if needed, goes through optional `server.py` RPC.
4. Avoid external network dependencies unless the user explicitly asks.
5. Keep the app self-contained under its app folder.
6. Do not store secrets or credentials in HTML/JS.
7. If JavaScript is used, design it as untrusted iframe content. Do not assume direct access to the parent dashboard or Hermes SDK; use the bridge helper for RPC.

## Recommended generation workflow

1. Pick an app name:
   - If the user names it, use that slug.
   - If the user does not name it, choose a short descriptive kebab-case name.
   - If it is temporary/throwaway, prefix with `temp-`.
2. Create `~/.hermes/ai-apps/apps/<app-name>/`.
3. Write `manifest.json` with `guid` equal to `<app-name>`.
4. Write `index.html` and any relative assets.
5. If backend logic is needed, add `server.py` with a module-level `FUNCTIONS` dict; otherwise omit it.
6. Verify required files exist.
7. Return the AI Apps dashboard URL and dashboard-hosted full URL.

Verification commands:

```bash
ROOT=~/.hermes/ai-apps/apps/<app-name>
test -f "$ROOT/index.html"
test -f "$ROOT/manifest.json"
python3 -m json.tool "$ROOT/manifest.json" >/dev/null
python3 -m py_compile "$ROOT/server.py"  # only if server.py exists
```

## Serverless app RPC

Apps may include `server.py` and declare functions in `manifest.json`:

```json
{
  "guid": "todo-demo",
  "type": "app",
  "title": "Todo Demo",
  "entry": "index.html",
  "server": {
    "type": "python-rpc",
    "entry": "server.py",
    "functions": ["get_state", "add_todo"]
  }
}
```

`server.py` protocol:

```python
from typing import Any


def get_state(payload: Any, context: Any) -> dict:
    return {"ok": True}


FUNCTIONS = {"get_state": get_state}
```

Handlers may be sync or async. They receive `payload` plus a context object with attributes:

```python
context.guid      # "<app-name>"
context.app_dir   # ".../dist/apps/<app-name>"
context.data_dir  # ".../dist/apps/<app-name>/data"
context.method    # HTTP method used at dispatcher
context.query     # query params dict
```

Use `Path(context.data_dir)` for per-app persisted files.

From the app iframe, call the parent playground through `postMessage` instead of directly fetching dashboard APIs. The plugin ships a small helper at `../../app-bridge.js` for apps under `dist/apps/<app-name>/`:

```html
<script>window.AI_APPS_GUID = "<app-name>";</script>
<script src="../../app-bridge.js"></script>
<script>
  const state = await window.AIApps.rpc("get_state", {}, { guid: "<app-name>" });
</script>
```

Manual message contract, if not using the helper:

```javascript
window.parent.postMessage({
  source: "ai-apps-app",
  type: "rpc",
  id: "unique-id",
  guid: "<app-name>",
  function: "get_state",
  payload: {}
}, "*");

window.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.source !== "ai-apps-host" || msg.type !== "rpc-result") return;
  // msg = {source, type, id, ok, data?, error?}
});
```

RPC works in two modes:

1. Inside the AI Apps dashboard preview iframe, `app-bridge.js` uses parent `postMessage` and the plugin SDK.
2. In a direct standalone static page, `app-bridge.js` falls back to same-origin direct fetch against `/api/plugins/ai-apps/apps/<app-name>/rpc/<function>` with AI Apps session-token handling.

Direct standalone URLs should be public dashboard-plugin static paths, not the compatibility `/ai-apps?item=...&view=full` launcher:

```text
# plugin-bundled app
/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html#...

# user app mirror generated from ~/.hermes/ai-apps/apps/<app-name>
/dashboard-plugins/ai-apps/dist/user-apps/<app-name>/index.html#...
```

Never use `/ai-apps?item=<app-name>&view=full#...` for app-to-app deep links; it is only a compatibility redirect route and can briefly show the launcher or lose fragment state. The direct standalone route relies on the dashboard's normal same-origin session boundary (for example, loopback or Tailscale access) and the bridge's silent token probe/retry behavior.

For app-to-app navigation, prewarm auth before changing pages to avoid a stale/no-token load from falling through to visible auth bounce:

```javascript
await window.AIApps.prewarmAuth();
window.location.href = "/dashboard-plugins/ai-apps/dist/user-apps/<target-app>/index.html#...";
```

For hover/focus prewarm on links:

```javascript
link.addEventListener("pointerenter", () => window.AIApps.prewarmAuth());
link.addEventListener("focus", () => window.AIApps.prewarmAuth());
```

## Archive / delete behavior

When maintaining the AI Apps dashboard, prefer a two-step destructive workflow:

1. Active apps live under `dist/apps/<app-name>/` and legacy static artifacts under `dist/sessions/<name>/`.
2. Archive moves folders out of the active scan roots into `dist/archive/apps/<app-name>/` or `dist/archive/sessions/<name>/` so they disappear from the main gallery without data loss.
3. The UI should expose permanent delete only from the Archive view; deletion should remove the archived folder from disk with `shutil.rmtree`, never delete directly from the main gallery.
4. Archive items need archive-aware static URLs such as `/dashboard-plugins/ai-apps/dist/archive/apps/<app-name>/index.html` so preview still works before deletion.
5. If `plugin_api.py` routes change, restart `hermes dashboard`; adding/moving app folders usually only needs refresh/rescan.

Quick smoke test pattern after archive changes:

```python
# Import dashboard/plugin_api.py, create a temp app folder with index.html + manifest.json,
# move it from APPS_DIR to ARCHIVE_APPS_DIR, assert it disappears from _list_artifacts(APPS_DIR),
# assert it appears in _list_artifacts(ARCHIVE_APPS_DIR, url_collection="archive/apps"),
# then shutil.rmtree the archived temp folder and assert it is gone.
```

## GitHub packaging recommendation

For a standalone AI Apps plugin repo, make the repository root installable as the plugin folder, e.g. `locus84/hermes-ai-apps-plugin` or `locus84/hermes-ai-apps`, with:

```text
README.md
samples/
  apps/
    rpc-counter-demo/
      index.html
      manifest.json
      server.py
  sessions/
dashboard/
  manifest.json
  plugin_api.py
  rpc_runner.py
  server_runner.py
  dist/
    index.js
    style.css
    app-bridge.js
    ai-apps-sw.js
    apps/          # active packaged apps only; keep examples in samples/apps
    sessions/      # active legacy static artifacts only; keep examples in samples/sessions
    archive/
```

The installed target should resolve to `~/.hermes/plugins/ai-apps/dashboard/manifest.json`. Keep experimental plugin iteration in the user plugin repo first; only upstream to Hermes core/bundled plugins after the plugin shape stabilizes.

## URLs to report

Dashboard gallery:

```text
http://127.0.0.1:9119/ai-apps
```

Direct standalone full view, with same-origin RPC fallback when `server.py` exists:

```text
# plugin-bundled apps under ~/.hermes/plugins/ai-apps/dashboard/dist/apps
http://127.0.0.1:9119/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html

# external user apps under ~/.hermes/ai-apps/apps
http://127.0.0.1:9119/dashboard-plugins/ai-apps/dist/user-apps/<app-name>/index.html
```

The dashboard `view=full` route is only a compatibility/deep-link entry point and should redirect to the app's standalone URL instead of rendering a dashboard iframe. Do not use `/ai-apps?item=<app-name>&view=full#...` for app-to-app links because the launcher can show an intermediate page and fragment state may be lost; link directly to `/dashboard-plugins/ai-apps/dist/user-apps/<app-name>/index.html#...` or the plugin-bundled `/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html#...` URL instead:

```text
http://127.0.0.1:9119/ai-apps?item=<app-name>&view=full
```

If the dashboard is running on a different host/port, replace `http://127.0.0.1:9119` with the active dashboard origin.

## Notes for agents

- Repository examples live under `samples/apps/*` and `samples/sessions/*`; do not leave demo apps in active `dashboard/dist/apps` or `dashboard/dist/sessions` scan roots unless you intentionally want them bundled into the running gallery. When the user asks whether samples are “uploaded” or wants reference examples, keep curated examples in `samples/`, not live scan roots, and point future agents to `samples/README.md`, `samples/apps/rpc-counter-demo/`, or `samples/apps/sample-rpc/` for serverless RPC implementation patterns.
- The AI Apps plugin dynamically scans both `~/.hermes/plugins/ai-apps/dashboard/dist/apps/*/manifest.json` and `~/.hermes/ai-apps/apps/*/manifest.json` through `/api/plugins/ai-apps/apps`. It also displays legacy `dist/sessions/*/manifest.json` entries for compatibility; new generated work should use `~/.hermes/ai-apps/apps/<app-name>/`.
- If `plugin_api.py` itself was added or changed, restart `hermes dashboard` so the FastAPI routes are remounted. Adding new app folders does not require restart.
- When verifying plugin API changes outside the dashboard process, use the Hermes runtime Python (`~/.hermes/hermes-agent/venv/bin/python`) so FastAPI and Hermes dependencies are available. If importing `plugin_api.py` via `importlib.util.spec_from_file_location`, insert the module into `sys.modules[spec.name]` before `exec_module`; dataclasses used by `plugin_api.py` expect their module to be registered.
- After restart, a direct unauthenticated `curl` to `/api/plugins/ai-apps/...` may return `401` because dashboard plugin APIs are session-protected. Treat `lsof`/process readiness and browser-authenticated dashboard checks as the health signal; do not mistake unauthenticated `401` for plugin startup failure.
- The dashboard iframe uses a sandbox. Build apps that work as standalone static pages; apps that need backend logic should use the postMessage RPC bridge.
- Current standalone full-view implementation is core-free: `dashboard/dist/index.js` mirrors `window.__HERMES_SESSION_TOKEN__` into AI Apps localStorage, treats `/ai-apps?auth=1&probe=1` as a silent token probe that must not redirect, and handles visible `/ai-apps?auth=1&return=<same-origin-app-url>` by immediately `location.replace`ing back; `dashboard/dist/app-bridge.js` first tries a silent same-origin `fetch('/ai-apps?auth=1&probe=1')`, parses the injected `window.__HERMES_SESSION_TOKEN__` from the returned HTML without navigating, caches it, exposes `window.AIApps.prewarmAuth()` for app-to-app navigation prewarm, registers `dashboard/dist/ai-apps-sw.js`, sends it the cached token, adds `X-Hermes-Session-Token` on direct RPC fetches, and on 401 clears stale cache, force-refreshes the token through the silent probe, retries the RPC once, then only falls back to visible `/ai-apps` bounce if the retry still cannot authorize. `plugin_api.py` mirrors user-app static files (excluding `server.py`, `data`, dotfiles, `__pycache__`) into `dashboard/dist/user-apps/<app>/` so user apps also get public `/dashboard-plugins/...` bookmark URLs while RPC still resolves against the original user app root.
- Commit hygiene for AI Apps plugin changes: do not commit runtime-generated public user-app mirrors (`dashboard/dist/user-apps/`), per-demo app state (`dashboard/dist/apps/*/data/`), or `__pycache__`; add/maintain `.gitignore` entries before staging. Commit source/runtime support files such as `dashboard/dist/ai-apps-sw.js`, bridge/dashboard JS, `plugin_api.py`, and skill references.
- For standalone full-view deployment without Hermes core changes, including Service Worker header injection, preauth/auth-bounce launcher links, cached dashboard session tokens, stable bookmark/share-link shape, commit hygiene, and why `/dashboard-plugins/...` cannot directly run RPC today, see `references/standalone-fullview-auth-patterns.md`.
- For app-to-app direct URL navigation, `/ai-apps?item=...&view=full#...` avoidance, stale token 401 retry flow, and `window.AIApps.prewarmAuth()` usage/verification, see `references/app-to-app-navigation-auth.md`.
- For RPC troubleshooting, obsolete bridge protocol migration, and context compatibility details, see `references/ai-apps-rpc-debugging.md`.
