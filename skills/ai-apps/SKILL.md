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

Create new apps under:

```text
~/.hermes/plugins/ai-apps/dashboard/dist/apps/<app-name>/
```

Canonical plugin identity is `ai-apps` everywhere: plugin folder `~/.hermes/plugins/ai-apps`, dashboard route `/ai-apps`, API prefix `/api/plugins/ai-apps`, static prefix `/dashboard-plugins/ai-apps`, and JS bridge globals `AIApps` / `AI_APPS_GUID`. Do not create new `ui-playground` paths or docs; keep old `UIPlayground` / `UI_PLAYGROUND_GUID` references only as compatibility aliases for existing apps.

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
2. Create `dist/apps/<app-name>/`.
3. Write `manifest.json` with `guid` equal to `<app-name>`.
4. Write `index.html` and any relative assets.
5. If backend logic is needed, add `server.py` with a module-level `FUNCTIONS` dict; otherwise omit it.
6. Verify required files exist.
7. Return the AI Apps dashboard URL and dashboard-hosted full URL.

Verification commands:

```bash
ROOT=~/.hermes/plugins/ai-apps/dashboard/dist/apps/<app-name>
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

1. Inside the AI Apps dashboard tab or dashboard-hosted full route (`/ai-apps?item=<app-name>&view=full`), `app-bridge.js` uses parent `postMessage` and the plugin SDK.
2. In a direct static full page (`/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html`), `app-bridge.js` falls back to same-origin direct fetch against `/dashboard-plugins/ai-apps/rpc/<app-name>/<function>`.

The direct route intentionally avoids `/api` because loopback dashboard auth uses an injected `X-Hermes-Session-Token` header that static full pages do not receive. It assumes the operator's dashboard/static hosting boundary, e.g. Tailscale, is the access boundary.

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
dashboard/
  manifest.json
  plugin_api.py
  rpc_runner.py
  server_runner.py
  dist/
    index.js
    style.css
    app-bridge.js
    apps/
    sessions/
    archive/
```

The installed target should resolve to `~/.hermes/plugins/ai-apps/dashboard/manifest.json`. Keep experimental plugin iteration in the user plugin repo first; only upstream to Hermes core/bundled plugins after the plugin shape stabilizes.

## URLs to report

Dashboard gallery:

```text
http://127.0.0.1:9119/ai-apps
```

Direct static full view, with same-origin RPC fallback when `server.py` exists:

```text
http://127.0.0.1:9119/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html
```

Dashboard-hosted preview/full route also works and keeps the parent bridge:

```text
http://127.0.0.1:9119/ai-apps?item=<app-name>&view=full
```

If the dashboard is running on a different host/port, replace `http://127.0.0.1:9119` with the active dashboard origin.

## Notes for agents

- The AI Apps plugin dynamically scans `dist/apps/*/manifest.json` through `/api/plugins/ai-apps/apps`. It also displays legacy `dist/sessions/*/manifest.json` entries for compatibility; new work should use `dist/apps/<app-name>/`.
- If `plugin_api.py` itself was added or changed, restart `hermes dashboard` so the FastAPI routes are remounted. Adding new app folders does not require restart.
- The dashboard iframe uses a sandbox. Build apps that work as standalone static pages; apps that need backend logic should use the postMessage RPC bridge.
- For RPC troubleshooting, obsolete bridge protocol migration, and context compatibility details, see `references/ai-apps-rpc-debugging.md`.
