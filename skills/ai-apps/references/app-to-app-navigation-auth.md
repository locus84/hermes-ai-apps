# AI Apps app-to-app navigation auth prewarm

Use this when standalone AI Apps link directly between apps and must avoid the `/ai-apps` launcher becoming visible during token bootstrap.

## Problem

Direct app links should use public static URLs, for example:

```text
/dashboard-plugins/ai-apps/dist/user-apps/iterave-kb-browser/index.html#doc=index.md
/dashboard-plugins/ai-apps/dist/user-apps/iterave-kb-obsidian/index.html#node=doc%3Aindex.md
```

Do not use `/ai-apps?item=<app>&view=full#...` for app-to-app deep links; it is a compatibility launcher and can briefly show the dashboard or lose fragment/hash state.

Even when app links are direct, each standalone app loads `../../app-bridge.js` and may need to bootstrap RPC auth. If cached token is missing/stale or a direct RPC returns 401, visible fallback to `/ai-apps?auth=1&return=...` can flash the dashboard unless the bridge first performs a silent token refresh.

## Bridge behavior to preserve

`dashboard/dist/app-bridge.js` should expose:

```javascript
await window.AIApps.prewarmAuth({ forceRefresh: false });
```

Expected behavior:

1. Call silent same-origin probe:
   ```javascript
   fetch('/ai-apps?auth=1&probe=1', {
     credentials: 'same-origin',
     cache: 'no-store',
     headers: { Accept: 'text/html' },
   })
   ```
2. Parse `window.__HERMES_SESSION_TOKEN__` from the returned dashboard HTML without navigating.
3. Cache the token in AI Apps same-origin storage.
4. Send it to `dashboard/dist/ai-apps-sw.js` so RPC fetches can add `X-Hermes-Session-Token`.
5. Return `true` when a token was acquired, otherwise `false`; do not navigate.

On RPC 401, do not immediately visible-bounce. Clear stale cache, force-refresh via the silent probe, retry the RPC once, and only then fallback to `/ai-apps?auth=1&return=...` if still unauthorized.

## App usage pattern

Before navigating to another app:

```javascript
async function goToApp(url) {
  if (window.AIApps && typeof window.AIApps.prewarmAuth === 'function') {
    await window.AIApps.prewarmAuth();
  }
  window.location.href = url;
}
```

For links, prewarm on intent as well as click:

```javascript
link.addEventListener('pointerenter', () => window.AIApps?.prewarmAuth?.());
link.addEventListener('focus', () => window.AIApps?.prewarmAuth?.());
link.addEventListener('click', async (event) => {
  event.preventDefault();
  await window.AIApps?.prewarmAuth?.();
  window.location.href = link.href;
});
```

For `_blank` navigation, prewarm first, then open the direct app URL:

```javascript
await window.AIApps?.prewarmAuth?.();
window.open(directAppUrl, '_blank', 'noopener');
```

## Dashboard probe rule

`/ai-apps?auth=1&probe=1` must not redirect, even if a `return=` parameter is present. Probe is an HTML read for token extraction. Only visible auth bounce URLs without `probe=1` should redirect to the return path.

## Verification checklist

- `node --check dashboard/dist/app-bridge.js` passes.
- Browser console on a direct app URL reports `typeof window.AIApps.prewarmAuth === 'function'`.
- After deleting `localStorage['ai-apps.sessionToken']`, `await window.AIApps.prewarmAuth({ forceRefresh: true })` returns `true`, repopulates the token, and leaves `location.href` on the direct app URL.
- App-to-app links remain `/dashboard-plugins/ai-apps/dist/user-apps/<app>/index.html#...`, not `/ai-apps?item=...&view=full#...`.
