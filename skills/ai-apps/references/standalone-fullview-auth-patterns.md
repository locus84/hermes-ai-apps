# Standalone full-view auth patterns for AI Apps

Session learning: AI Apps can remain a dashboard plugin without Hermes core changes, but standalone full-view apps that call `server.py` RPC must handle the dashboard auth boundary deliberately.

## Current Hermes route split

- Public static plugin assets:
  - `/dashboard-plugins/ai-apps/dist/apps/<app>/index.html`
  - Works as a standalone page without custom headers.
- Authenticated plugin backend:
  - `/api/plugins/ai-apps/apps/<app>/rpc/<function>`
  - Protected by Hermes dashboard `/api/*` session-token middleware in loopback mode.
  - Browser address-bar navigation cannot attach `X-Hermes-Session-Token`, so direct unauthenticated RPC yields `401 Unauthorized`.

Key fact: `/dashboard-plugins/...` and `/api/plugins/...` are the same origin when served by the same dashboard host/port. Static app JavaScript, localStorage/IndexedDB, and Service Workers can therefore cooperate with authenticated same-origin API fetches once a token is bootstrapped.

## What other platforms typically do

- Grafana: core-supported plugin backend/resource routes; plugin frontend calls them through Grafana runtime/auth context.
- Home Assistant: core ingress/proxy handles auth and routes add-on UIs.
- VS Code webviews: webview communicates with extension host via message passing, not standalone public backend URLs.
- Jupyter/JupyterLab: frontend uses server connection settings/token/cookie to call authenticated server-extension APIs.

Implication for Hermes: one-port, no-core-change standalone RPC is only practical if the app can acquire and send the existing dashboard session token, or if Hermes core later adds a plugin public_api/ingress/resource route.

## Impossible without core/proxy/port changes

- True cold 0-click RPC in a fresh browser that has never visited the dashboard: there is no token-bearing state and top-level navigation cannot add the required header.
- Cookie-only automatic auth for `/api/plugins/...`: current loopback mode checks the session token header, not a plugin-configurable cookie policy.
- Public dynamic RPC under `/dashboard-plugins/...`: that prefix is static asset serving in core.
- Extra sidecar server without another port: sidecars need either a port or a core/reverse-proxy ingress.
- Token-in-URL sharing: technically possible but rejected for bookmark/share UX because browser history, logs, referrers, and copied links leak the bearer secret.

## Recommended core-free pattern: standalone static + silent dashboard HTML probe + Service Worker header injection

Use the existing authenticated API, but make standalone app fetches attach the dashboard token automatically.

1. App static is served from public plugin static:
   - Plugin-bundled apps: `/dashboard-plugins/ai-apps/dist/apps/<app>/index.html`
   - User apps mirrored from `~/.hermes/ai-apps/apps`: `/dashboard-plugins/ai-apps/dist/user-apps/<app>/index.html`
2. `app-bridge.js` first tries a silent same-origin HTML probe:
   - `fetch('/ai-apps?auth=1&probe=1', { credentials: 'same-origin' })`
   - parses the dashboard-injected `window.__HERMES_SESSION_TOKEN__` from the returned HTML without navigating
   - stores it in AI Apps-owned same-origin storage (prefer IndexedDB/localStorage for bookmark persistence; sessionStorage is safer but fails new-tab/bookmark persistence)
3. `/ai-apps` dashboard page remains a visible fallback preauth launcher:
   - reads the dashboard session token exposed to the dashboard bundle
   - must not redirect when `probe=1`, even if `auth=1` and `return=...` are present; probe requests are HTML reads for token extraction
   - redirects to the standalone app URL only for visible auth bounce URLs such as `/ai-apps?auth=1&return=<encoded-app-url>` or state launchers such as `/ai-apps?launch=<app>&mode=full&state=<state>`
4. The standalone app registers an AI Apps Service Worker scoped to the static app area.
5. The Service Worker intercepts same-origin requests to `/api/plugins/ai-apps/...`, clones the request, adds `X-Hermes-Session-Token: <token>`, and forwards it.
6. App code and `app-bridge.js` can use ordinary `fetch('/api/plugins/ai-apps/apps/<app>/rpc/<function>')`; the SW owns auth header injection.
7. If RPC returns 401 with a cached token, clear stale cache, force-refresh via `/ai-apps?auth=1&probe=1`, retry the RPC once with the new token, and only visible-bounce to `/ai-apps?auth=1&return=...` if the retry still cannot authorize.

Why Service Worker helps:

- Avoids sprinkling token handling through generated app JavaScript.
- Keeps the bookmark URL token-free and stable.
- Supports full-page standalone/PWA-style apps without iframe or opener.
- Lets `app-bridge.js` keep iframe/opener postMessage as a fast path while standalone direct fetch uses the same RPC URL.

### Share/bookmark URL shape

Preferred stable bookmark/deep-link URLs:

```text
# plugin-bundled app
/dashboard-plugins/ai-apps/dist/apps/<app>/index.html#...

# user app
/dashboard-plugins/ai-apps/dist/user-apps/<app>/index.html#...
```

Do not use `/ai-apps?item=<app>&view=full#...` for app-to-app links. That route is a compatibility launcher; it may briefly show the dashboard and fragment/hash state can be lost during redirect.

Cold/no-token recovery URL generated by the app or bridge:

```text
# plugin-bundled app
/ai-apps?auth=1&return=%2Fdashboard-plugins%2Fai-apps%2Fdist%2Fapps%2F<app>%2Findex.html

# user app
/ai-apps?auth=1&return=%2Fdashboard-plugins%2Fai-apps%2Fdist%2Fuser-apps%2F<app>%2Findex.html
```

Stateful share-link launcher, when the app has shareable state:

```text
/ai-apps?launch=<app>&mode=full&state=<url-safe-state>
```

The launcher prepares auth, then redirects to:

```text
/dashboard-plugins/ai-apps/dist/apps/<app>/index.html#state=<url-safe-state>
```

Do not share raw session tokens. Another authorized browser/user must still have access to the Hermes dashboard origin; this is not anonymous public hosting.

## Token persistence choices

- `sessionStorage`: safest persistence, but per-tab; bookmarked pages opened later often lack the token and need the bounce.
- `localStorage`: practical for bookmarkable apps; any same-origin JS can read it, so treat the dashboard origin as trusted and avoid third-party scripts.
- IndexedDB behind a Service Worker: better encapsulation than globals/localStorage for generated app code, but still same-origin accessible to code that intentionally opens the database; not a hard XSS boundary.
- `HERMES_DASHBOARD_SESSION_TOKEN` pinned to a strong random value: improves restart/bookmark UX because cached tokens survive dashboard restart. Treat it as a long-lived bearer secret and rotate deliberately.
- Static HTML/JS token bake-in: avoid; it turns public static files into bearer secret carriers and goes stale after token rotation.

## Commit hygiene for this pattern

When committing the plugin implementation, include source/runtime support files and exclude generated state:

- Commit: `dashboard/dist/ai-apps-sw.js`, `dashboard/dist/app-bridge.js`, `dashboard/dist/index.js`, `dashboard/plugin_api.py`, relevant skill/reference docs, `.gitignore` updates, and curated examples under `samples/apps/*` / `samples/sessions/*`.
- Do not commit: active runtime sample copies in `dashboard/dist/apps/*` or `dashboard/dist/sessions/*` unless intentionally bundled, `dashboard/dist/user-apps/` mirrors generated from `~/.hermes/ai-apps/apps`, any `*/data/` app state, `__pycache__/`, or `.pyc` files.
- User-app mirror generation is runtime behavior in `plugin_api.py`; the repository should not carry a stale mirror of a local user's app. Keep reusable examples in `samples/` and have skills/docs point there.

## UX and security tradeoffs

- First-time cold load should first try the silent same-origin HTML probe; visible `/ai-apps?auth=1&return=...` bounce is only fallback. If it loops, show a clear “Open `/ai-apps` once to authorize AI Apps RPC” action.
- `127.0.0.1` links are only meaningful on the same machine; use the active dashboard origin (for example Tailscale hostname) when sharing remotely.
- Browser true fullscreen (`requestFullscreen`) still needs a user gesture; a link can provide full-page layout/PWA standalone display but cannot force OS/browser fullscreen.
- Same-origin XSS can steal or use the token. This risk already exists for the dashboard bundle; reduce it by keeping apps self-contained, avoiding external scripts, and limiting token storage to the narrowest persistence that satisfies bookmarks.

## Long-term clean design

For polished distribution, add a generic Hermes dashboard plugin capability such as:

```json
{
  "api": "plugin_api.py",
  "public_api": "public_api.py"
}
```

Mounted as, for example:

```text
/api/plugins/<name>/...                 authenticated admin/plugin API
/dashboard-plugins/<name>/api/...       app-facing public/signed/ticket API
```

This keeps AI Apps logic inside the plugin while making one-port standalone static + RPC first-class, similar to Grafana resources or Home Assistant ingress.