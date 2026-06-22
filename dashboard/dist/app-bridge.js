window.AIApps = window.AIApps || (function () {
  let seq = 0;
  const pending = new Map();
  const TOKEN_KEY = "ai-apps.sessionToken";
  const TOKEN_UPDATED_KEY = "ai-apps.sessionTokenUpdatedAt";
  const SESSION_HEADER = "X-Hermes-Session-Token";

  function rpcPath(guid, functionName) {
    return "/api/plugins/ai-apps/apps/" +
      encodeURIComponent(guid) + "/rpc/" + encodeURIComponent(functionName);
  }

  function currentPathWithHash() {
    return window.location.pathname + window.location.search + window.location.hash;
  }

  function authBounceUrl() {
    return "/ai-apps?auth=1&return=" + encodeURIComponent(currentPathWithHash());
  }

  function cacheToken(token) {
    if (!token || typeof token !== "string") return "";
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
      window.localStorage.setItem(TOKEN_UPDATED_KEY, new Date().toISOString());
    } catch (_) {}
    return token;
  }

  function cachedToken() {
    if (typeof window.__HERMES_SESSION_TOKEN__ === "string" && window.__HERMES_SESSION_TOKEN__) {
      return cacheToken(window.__HERMES_SESSION_TOKEN__);
    }
    try {
      return window.localStorage.getItem(TOKEN_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function parseTokenFromDashboardHtml(html) {
    if (!html || typeof html !== "string") return "";
    const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*(['"])(.*?)\1/);
    if (!match) return "";
    try {
      return JSON.parse(match[1] + match[2] + match[1]);
    } catch (_) {
      return match[2] || "";
    }
  }

  async function discoverSessionTokenSilently(forceRefresh) {
    const existing = cachedToken();
    if (existing && !forceRefresh) return existing;
    try {
      const response = await fetch("/ai-apps?auth=1&probe=1", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Accept": "text/html" },
      });
      if (!response.ok) return "";
      const token = parseTokenFromDashboardHtml(await response.text());
      return cacheToken(token);
    } catch (_) {
      return "";
    }
  }

  function clearCachedToken() {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(TOKEN_UPDATED_KEY);
    } catch (_) {}
  }

  function sendTokenToServiceWorker(token) {
    if (!token || !("serviceWorker" in navigator)) return;
    const message = { source: "ai-apps-app", type: "session-token", token: token };
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(message);
    }
    navigator.serviceWorker.ready.then(function (registration) {
      const worker = registration.active || registration.waiting || registration.installing;
      if (worker) worker.postMessage(message);
    }).catch(function () {});
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const token = cachedToken();
    navigator.serviceWorker.register("/dashboard-plugins/ai-apps/dist/ai-apps-sw.js", {
      scope: "/dashboard-plugins/ai-apps/dist/",
    }).then(function () {
      sendTokenToServiceWorker(token);
    }).catch(function () {});
  }

  registerServiceWorker();

  async function prewarmAuth(options) {
    options = options || {};
    const token = await discoverSessionTokenSilently(!!options.forceRefresh);
    if (!token) return false;
    sendTokenToServiceWorker(token);
    return true;
  }

  window.addEventListener("message", function (event) {
    const message = event.data || {};
    if ((message.source !== "ai-apps-host" && message.source !== "ui-playground-host") || message.type !== "rpc-result") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.data);
    else entry.reject(new Error(message.error || "RPC failed"));
  });

  function parentBridgeAvailable() {
    return window.parent && window.parent !== window;
  }

  function openerBridgeAvailable() {
    try {
      return !!(window.opener && !window.opener.closed);
    } catch (_) {
      return false;
    }
  }

  function postMessageRpc(targetWindow, functionName, payload, options) {
    const id = "rpc-" + Date.now() + "-" + (++seq);
    const timeoutMs = options.timeoutMs || 12000;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("RPC timed out"));
      }, timeoutMs);
      pending.set(id, {
        resolve: function (value) { clearTimeout(timer); resolve(value); },
        reject: function (error) { clearTimeout(timer); reject(error); },
      });
      targetWindow.postMessage({
        source: "ai-apps-app",
        type: "rpc",
        id: id,
        guid: options.guid || window.AI_APPS_GUID || window.UI_PLAYGROUND_GUID,
        function: functionName,
        payload: payload,
      }, "*");
    });
  }

  function bounceForAuth() {
    if (window.location.pathname === "/ai-apps") return;
    window.location.replace(authBounceUrl());
  }

  async function readRpcResponse(response) {
    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); }
      catch (_) { data = { ok: false, error: text }; }
    }
    return data;
  }

  function rpcResultOrThrow(response, data) {
    if (!response.ok) {
      const detail = data && (data.detail || data.error);
      throw new Error(typeof detail === "string" ? detail : (response.status + ": " + response.statusText));
    }
    if (data && data.ok === false) {
      throw new Error(data.error || "RPC failed");
    }
    return data && Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
  }

  async function directFetchRpc(functionName, payload, options) {
    const guid = options.guid || window.AI_APPS_GUID || window.UI_PLAYGROUND_GUID;
    if (!guid) throw new Error("Missing AI_APPS_GUID for direct RPC");
    const body = JSON.stringify(payload == null ? {} : payload);
    let token = await discoverSessionTokenSilently(false);
    if (token) sendTokenToServiceWorker(token);
    const headers = { "Content-Type": "application/json" };
    if (token) headers[SESSION_HEADER] = token;
    const requestOptions = {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: body,
    };
    let response = await fetch(rpcPath(guid, functionName), requestOptions);
    let data = await readRpcResponse(response);

    if (response.status === 401 && token) {
      clearCachedToken();
      token = await discoverSessionTokenSilently(true);
      if (token) {
        sendTokenToServiceWorker(token);
        headers[SESSION_HEADER] = token;
        response = await fetch(rpcPath(guid, functionName), requestOptions);
        data = await readRpcResponse(response);
        if (response.ok) return rpcResultOrThrow(response, data);
      }
    }

    if (response.status === 401) {
      clearCachedToken();
      bounceForAuth();
      throw new Error("AI Apps authorization required; redirecting to /ai-apps.");
    }
    return rpcResultOrThrow(response, data);
  }

  function rpc(functionName, payload, options) {
    options = options || {};
    if (parentBridgeAvailable()) {
      return postMessageRpc(window.parent, functionName, payload, options);
    }
    if (openerBridgeAvailable()) {
      return postMessageRpc(window.opener, functionName, payload, options);
    }
    return directFetchRpc(functionName, payload, options);
  }

  return { rpc: rpc, prewarmAuth: prewarmAuth };
})();

window.UIPlayground = window.UIPlayground || window.AIApps;
