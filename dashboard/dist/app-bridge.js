window.AIApps = window.AIApps || (function () {
  let seq = 0;
  const pending = new Map();

  function rpcPath(guid, functionName) {
    return "/api/plugins/ai-apps/apps/" +
      encodeURIComponent(guid) + "/rpc/" + encodeURIComponent(functionName);
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

  async function directFetchRpc(functionName, payload, options) {
    const guid = options.guid || window.AI_APPS_GUID || window.UI_PLAYGROUND_GUID;
    if (!guid) throw new Error("Missing AI_APPS_GUID for direct RPC");
    const response = await fetch(rpcPath(guid, functionName), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload == null ? {} : payload),
    });
    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); }
      catch (_) { data = { ok: false, error: text }; }
    }
    if (!response.ok) {
      const detail = data && (data.detail || data.error);
      throw new Error(typeof detail === "string" ? detail : (response.status + ": " + response.statusText));
    }
    if (data && data.ok === false) {
      throw new Error(data.error || "RPC failed");
    }
    return data && Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
  }

  function rpc(functionName, payload, options) {
    options = options || {};
    if (parentBridgeAvailable()) {
      return postMessageRpc(window.parent, functionName, payload, options);
    }
    if (openerBridgeAvailable() && options.preferOpener) {
      return postMessageRpc(window.opener, functionName, payload, options);
    }
    return directFetchRpc(functionName, payload, options);
  }

  return { rpc: rpc };
})();

window.UIPlayground = window.UIPlayground || window.AIApps;
