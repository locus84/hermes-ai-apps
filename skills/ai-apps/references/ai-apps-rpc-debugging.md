# AI Apps RPC debugging notes

Use this when an AI Apps app-in-app renders but its server.py RPC does not respond.

## Current bridge contract

Apps under `dist/apps/<app-name>/` should normally load the shared bridge helper:

```html
<script>window.AI_APPS_GUID = "<app-name>";</script>
<script src="../../app-bridge.js"></script>
<script>
  const state = await window.AIApps.rpc("get_state", {}, { guid: "<app-name>" });
</script>
```

The helper sends messages shaped like:

```js
{
  source: "ai-apps-app",
  type: "rpc",
  id,
  guid: "<app-name>",
  function: "get_state",
  payload: {}
}
```

The dashboard host replies with:

```js
{
  source: "ai-apps-host",
  type: "rpc-result",
  id,
  ok,
  data,
  error
}
```

Older demos may still use the obsolete protocol (`type: "ai-apps-rpc"` / `type: "ai-apps-rpc-result"`). Update those demos to the helper above instead of trying to support both ad hoc in every app.

## Full-view rule

RPC now supports both hosted and direct full views:

```text
/ai-apps?item=<app-name>&view=full
/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html
```

Inside the dashboard route, `app-bridge.js` uses parent `postMessage` and the plugin SDK. In the direct static page, `app-bridge.js` falls back to same-origin direct fetch:

```text
POST /dashboard-plugins/ai-apps/rpc/<app-name>/<function>
```

This direct route is intentionally not under `/api`, because loopback dashboard auth requires the SPA-injected `X-Hermes-Session-Token` header and static full pages do not receive it. The tradeoff assumes the dashboard/static hosting boundary is trusted, such as a Tailscale-only deployment.

## server.py context compatibility

Dashboard/runner revisions may pass `context` as either an object with attributes or a dict. App server.py files should tolerate both:

```python
def _ctx(context, key: str, default=None):
    if isinstance(context, dict):
        return context.get(key, default)
    return getattr(context, key, default)


def data_path(context):
    from pathlib import Path
    data_dir = _ctx(context, "data_dir") or (Path(_ctx(context, "app_dir", ".")) / "data")
    return Path(data_dir)
```

Use `Path(_ctx(context, "data_dir"))` for persisted per-app state and create the directory before writing.

## Browser reproduction checklist

1. Open `/ai-apps?item=<app-name>&view=full`.
2. Confirm static assets load:
   - `/dashboard-plugins/ai-apps/dist/apps/<app-name>/index.html` → 200
   - `/dashboard-plugins/ai-apps/dist/app-bridge.js` → 200 when using bridge helper
3. Confirm RPC endpoints return 200:
   - Hosted dashboard route: `/api/plugins/ai-apps/apps/<app-name>/rpc/get_state`
   - Direct static full route: `/dashboard-plugins/ai-apps/rpc/<app-name>/get_state`
   - Function calls: the matching `/rpc/<function>` path for the mode being tested
4. If the frame stays on `Loading…`, check for JavaScript parse errors first. A broken inline script prevents the bridge call entirely.
5. If RPC returns 500, inspect the server.py traceback. Common issue: assuming dict-only or object-only context.

Ignore unrelated dashboard 401s unless they are for `/api/plugins/ai-apps/...`; UI Apps RPC success is determined by the plugin app endpoints above.