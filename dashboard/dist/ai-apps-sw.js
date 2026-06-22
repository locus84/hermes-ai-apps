/* AI Apps standalone auth helper.
 * Controls pages under /dashboard-plugins/ai-apps/dist/ and injects the
 * dashboard session token into same-origin AI Apps plugin API requests.
 */
(function () {
  "use strict";

  let sessionToken = "";
  const API_PREFIX = "/api/plugins/ai-apps/";
  const HEADER = "X-Hermes-Session-Token";

  self.addEventListener("install", function (event) {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("message", function (event) {
    const message = event.data || {};
    if (message.source !== "ai-apps-app" || message.type !== "session-token") return;
    sessionToken = typeof message.token === "string" ? message.token : "";
  });

  self.addEventListener("fetch", function (event) {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(API_PREFIX) || !sessionToken) {
      return;
    }

    const headers = new Headers(event.request.headers);
    if (!headers.has(HEADER)) {
      headers.set(HEADER, sessionToken);
    }

    const authedRequest = new Request(event.request, {
      headers: headers,
      credentials: event.request.credentials === "omit" ? "same-origin" : event.request.credentials,
    });
    event.respondWith(fetch(authedRequest));
  });
})();
