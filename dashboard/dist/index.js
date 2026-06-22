(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) {
    console.warn("ai-apps: Hermes plugin SDK is not available");
    return;
  }

  const React = SDK.React;
  const h = React.createElement;
  const useEffect = SDK.hooks.useEffect;
  const useMemo = SDK.hooks.useMemo;
  const useRef = SDK.hooks.useRef;
  const useState = SDK.hooks.useState;

  function fmtDate(value) {
    if (!value) return "unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function itemSlug(item) {
    return item.folder || item.slug || item.guid || "";
  }

  function itemKind(item) {
    if (item.collection === "apps" || item.server) return "app";
    return "static";
  }

  const TOKEN_KEY = "ai-apps.sessionToken";
  const TOKEN_UPDATED_KEY = "ai-apps.sessionTokenUpdatedAt";

  function matches(item, query) {
    if (!query) return true;
    const haystack = [
      item.guid,
      item.folder,
      item.slug,
      item.title,
      item.description,
      item.author,
      item.type,
      item.collection,
      item.archived ? "archived archive" : "active",
      ...(item.tags || []),
    ].join(" ").toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  function mirrorDashboardSessionToken() {
    const token = typeof window.__HERMES_SESSION_TOKEN__ === "string" ? window.__HERMES_SESSION_TOKEN__ : "";
    if (!token) return false;
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
      window.localStorage.setItem(TOKEN_UPDATED_KEY, new Date().toISOString());
      return true;
    } catch (_) {
      return false;
    }
  }

  function safeReturnPath(raw) {
    if (!raw) return "";
    try {
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin) return "";
      const path = url.pathname;
      const allowed = path.startsWith("/dashboard-plugins/ai-apps/dist/apps/") ||
        path.startsWith("/dashboard-plugins/ai-apps/dist/user-apps/") ||
        path.startsWith("/api/plugins/ai-apps/static/apps/");
      if (!allowed) return "";
      return path + url.search + url.hash;
    } catch (_) {
      return "";
    }
  }

  function normalizeItems(data, collection, archived) {
    const raw = data && Array.isArray(data.items) ? data.items : [];
    return raw.map(function (item) {
      const sourceCollection = item.collection || collection;
      return Object.assign({}, item, {
        collection: sourceCollection,
        archived: !!archived,
        type: item.type || (sourceCollection === "apps" ? "app" : "static"),
      });
    });
  }

  function AIAppsPage() {
    const initialParams = new URLSearchParams(window.location.search);
    const authReturnPath = safeReturnPath(initialParams.get("return") || "");
    const authProbe = initialParams.get("probe") === "1";
    const authBounce = initialParams.get("auth") === "1" && !authProbe && !!authReturnPath;
    const initialTarget = initialParams.get("item") || initialParams.get("app") || initialParams.get("artifact") || initialParams.get("guid") || "";
    const initialFullView = initialParams.get("view") === "full";

    const [activeItems, setActiveItems] = useState([]);
    const [archiveItems, setArchiveItems] = useState([]);
    const [selectedUrl, setSelectedUrl] = useState("");
    const [selectedSlug, setSelectedSlug] = useState(initialTarget);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(true);
    const [busyAction, setBusyAction] = useState("");
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [fullView, setFullView] = useState(initialFullView);
    const [viewMode, setViewMode] = useState("active");
    const frameRef = useRef(null);
    const fullWindowRef = useRef(null);

    const load = React.useCallback(function () {
      setLoading(true);
      setError("");
      Promise.all([
        SDK.fetchJSON("/api/plugins/ai-apps/apps").catch(function () { return { items: [] }; }),
        SDK.fetchJSON("/api/plugins/ai-apps/sessions").catch(function () { return { items: [] }; }),
        SDK.fetchJSON("/api/plugins/ai-apps/archive").catch(function () { return { items: [] }; }),
      ])
        .then(function (results) {
          const active = normalizeItems(results[0], "apps", false).concat(normalizeItems(results[1], "sessions", false));
          const archived = normalizeItems(results[2], "archive", true);
          const current = viewMode === "archive" ? archived : active;
          setActiveItems(active);
          setArchiveItems(archived);
          if (current.length && !current.some(function (item) { return item.url === selectedUrl; })) {
            const target = current.find(function (item) {
              const slug = itemSlug(item);
              return selectedSlug && (slug === selectedSlug || item.guid === selectedSlug);
            }) || current[0];
            setSelectedUrl(target.url);
            setSelectedSlug(itemSlug(target));
          }
          if (!current.length) {
            setSelectedUrl("");
            setSelectedSlug("");
          }
        })
        .catch(function (err) {
          setError(err && err.message ? err.message : String(err));
        })
        .finally(function () { setLoading(false); });
    }, [selectedUrl, selectedSlug, viewMode]);

    useEffect(function () { load(); }, [viewMode]);

    useEffect(function () {
      mirrorDashboardSessionToken();
      if (authBounce && authReturnPath) {
        window.location.replace(authReturnPath);
      }
    }, []);

    useEffect(function () {
      if (!fullView || !selectedUrl) return;
      const target = new URL(selectedUrl, window.location.origin);
      if (!target.hash && window.location.hash) target.hash = window.location.hash;
      window.location.replace(target.toString());
    }, [fullView, selectedUrl]);

    useEffect(function () {
      function onMessage(event) {
        const frame = frameRef.current;
        const fullWindow = fullWindowRef.current;
        const fromFrame = !!(frame && event.source === frame.contentWindow);
        const fromFullWindow = !!(fullWindow && !fullWindow.closed && event.source === fullWindow);
        if (!fromFrame && !fromFullWindow) return;
        const message = event.data || {};
        if (!message || (message.source !== "ai-apps-app" && message.source !== "ui-playground-app") || message.type !== "rpc") return;
        const id = message.id || String(Date.now());
        const guid = message.guid || selectedSlug;
        const fn = message.function || message.functionName;
        if (!guid || !fn) {
          event.source.postMessage({ source: "ai-apps-host", type: "rpc-result", id, ok: false, error: "missing app name or function" }, event.origin || "*");
          return;
        }
        SDK.fetchJSON("/api/plugins/ai-apps/apps/" + encodeURIComponent(guid) + "/rpc/" + encodeURIComponent(fn), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload === undefined ? null : message.payload),
        }).then(function (data) {
          event.source.postMessage({ source: "ai-apps-host", type: "rpc-result", id, ok: true, data: data.result }, event.origin || "*");
        }).catch(function (err) {
          event.source.postMessage({ source: "ai-apps-host", type: "rpc-result", id, ok: false, error: err && err.message ? err.message : String(err) }, event.origin || "*");
        });
      }
      window.addEventListener("message", onMessage);
      return function () { window.removeEventListener("message", onMessage); };
    }, [selectedSlug]);

    const items = viewMode === "archive" ? archiveItems : activeItems;
    const visible = useMemo(function () {
      return items.filter(function (item) { return matches(item, query); });
    }, [items, query]);

    const selected = items.find(function (item) { return item.url === selectedUrl; }) || null;

    function select(item) {
      const slug = itemSlug(item);
      setSelectedUrl(item.url);
      setSelectedSlug(slug);
      if (fullView && item.url) {
        window.location.replace(new URL(item.url, window.location.origin).toString());
      }
    }

    function directFullUrl() {
      if (!selectedUrl) return "";
      return new URL(selectedUrl, window.location.origin).toString();
    }

    function openFull() {
      const url = directFullUrl();
      if (url) fullWindowRef.current = window.open(url, "_blank");
    }

    function exitFull() {
      setFullView(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      window.history.replaceState(null, "", url.toString());
    }

    function copyUrl() {
      if (!selectedUrl || !navigator.clipboard) return;
      const absolute = directFullUrl();
      navigator.clipboard.writeText(absolute).catch(function () {});
    }

    function switchMode(nextMode) {
      setViewMode(nextMode);
      setSelectedUrl("");
      setSelectedSlug("");
      setNotice("");
    }

    function runItemAction(item, action) {
      const slug = itemSlug(item);
      const collection = item.collection;
      if (!slug || !collection || busyAction) return;
      let path = "";
      let options = { method: "POST" };
      let message = "";

      if (action === "archive") {
        message = "Archive " + slug + "? It will disappear from the main AI Apps list.";
        path = "/api/plugins/ai-apps/" + encodeURIComponent(collection) + "/" + encodeURIComponent(slug) + "/archive";
      } else if (action === "restore") {
        message = "Restore " + slug + " to the main AI Apps list?";
        path = "/api/plugins/ai-apps/archive/" + encodeURIComponent(collection) + "/" + encodeURIComponent(slug) + "/restore";
      } else if (action === "delete") {
        message = "Permanently delete archived app " + slug + "? This removes the folder from disk.";
        path = "/api/plugins/ai-apps/archive/" + encodeURIComponent(collection) + "/" + encodeURIComponent(slug);
        options = { method: "DELETE" };
      }

      if (!path || !window.confirm(message)) return;
      setBusyAction(action + ":" + slug);
      setNotice("");
      SDK.fetchJSON(path, options)
        .then(function () {
          setNotice(action === "archive" ? "Archived " + slug : action === "restore" ? "Restored " + slug : "Deleted " + slug);
          setSelectedUrl("");
          setSelectedSlug("");
          load();
        })
        .catch(function (err) {
          setError(err && err.message ? err.message : String(err));
        })
        .finally(function () { setBusyAction(""); });
    }

    function renderItemActions(item) {
      const slug = itemSlug(item);
      const disabled = !!busyAction;
      if (viewMode === "archive") {
        return h("div", { className: "ai-apps-card-actions" },
          h("button", {
            className: "ai-apps-button ai-apps-button-small",
            disabled,
            onClick: function (event) { event.stopPropagation(); runItemAction(item, "restore"); },
          }, busyAction === "restore:" + slug ? "Restoring…" : "Restore"),
          h("button", {
            className: "ai-apps-button ai-apps-button-small ai-apps-button-danger",
            disabled,
            onClick: function (event) { event.stopPropagation(); runItemAction(item, "delete"); },
          }, busyAction === "delete:" + slug ? "Deleting…" : "Delete")
        );
      }
      return h("div", { className: "ai-apps-card-actions" },
        h("button", {
          className: "ai-apps-button ai-apps-button-small",
          disabled,
          onClick: function (event) { event.stopPropagation(); runItemAction(item, "archive"); },
        }, busyAction === "archive:" + slug ? "Archiving…" : "Archive")
      );
    }

    if (authBounce) {
      return h("div", { className: "ai-apps-root ai-apps-auth-bounce", "aria-live": "polite" },
        h("section", { className: "ai-apps-card" },
          h("h3", null, "Opening AI App…"),
          h("p", null, "Authorizing the standalone app and returning immediately.")
        )
      );
    }

    return h("div", { className: "ai-apps-root", "data-full": fullView ? "true" : "false" },
      h("section", { className: "ai-apps-toolbar" },
        h("div", { className: "ai-apps-title" },
          h("h2", null, "AI Apps"),
          h("p", null, "Named app-in-app experiments. Archive hides apps from the main list; deleting is only available inside Archive.")
        ),
        h("div", { className: "ai-apps-actions" },
          h("div", { className: "ai-apps-segmented" },
            h("button", { className: "ai-apps-button", "data-active": viewMode === "active" ? "true" : "false", onClick: function () { switchMode("active"); } }, "Main (" + activeItems.length + ")"),
            h("button", { className: "ai-apps-button", "data-active": viewMode === "archive" ? "true" : "false", onClick: function () { switchMode("archive"); } }, "Archive (" + archiveItems.length + ")")
          ),
          h("input", {
            className: "ai-apps-input",
            placeholder: viewMode === "archive" ? "Search archived apps…" : "Search app name, title, tag…",
            value: query,
            onChange: function (event) { setQuery(event.target.value); },
          }),
          h("button", { className: "ai-apps-button", onClick: load }, loading ? "Loading…" : "Refresh"),
          h("button", { className: "ai-apps-button", disabled: !selectedUrl, onClick: copyUrl }, "Copy static URL"),
          h("button", { className: "ai-apps-button", disabled: !selectedUrl, onClick: openFull }, fullView ? "Open another full" : "Open full"),
          fullView ? h("button", { className: "ai-apps-button", onClick: exitFull }, "Exit full") : null
        )
      ),

      notice ? h("section", { className: "ai-apps-notice" }, notice) : null,

      error ? h("section", { className: "ai-apps-card" },
        h("h3", null, "Failed to load apps"),
        h("p", null, error),
        h("p", null, "If plugin_api.py changed, restart `hermes dashboard` so the routes are re-mounted.")
      ) : null,

      h("section", { className: "ai-apps-layout", "data-full": fullView ? "true" : "false" },
        fullView ? null : h("aside", { className: "ai-apps-list" },
          visible.length ? visible.map(function (item) {
            const slug = itemSlug(item);
            const isSelected = item.url === selectedUrl;
            const kind = itemKind(item);
            return h("button", {
              key: (item.archived ? "archive:" : "active:") + item.collection + ":" + (slug || item.url),
              className: "ai-apps-card",
              "data-selected": isSelected ? "true" : "false",
              onClick: function () { select(item); },
            },
              h("div", { className: "ai-apps-card-head" },
                h("h3", null, item.title || slug),
                renderItemActions(item)
              ),
              h("p", null, item.description || "No description"),
              h("p", null, "Name: ", h("code", null, slug)),
              h("p", null, "Updated: ", fmtDate(item.updated_at || item.created_at)),
              item.server ? h("p", null, "Server: ", item.server.has_server ? item.server.type : "none") : null,
              h("div", { className: "ai-apps-meta" },
                h("span", { className: "ai-apps-pill" }, kind === "app" ? "app" : "static"),
                item.archived ? h("span", { className: "ai-apps-pill" }, "archived") : null,
                item.collection === "sessions" ? h("span", { className: "ai-apps-pill" }, "legacy") : null,
                item.source ? h("span", { className: "ai-apps-pill" }, item.source === "user" ? "user app" : "plugin app") : null,
                (item.tags || []).slice(0, 8).map(function (tag) {
                  return h("span", { className: "ai-apps-pill", key: tag }, tag);
                }),
                item.author ? h("span", { className: "ai-apps-pill" }, item.author) : null
              )
            );
          }) : h("div", { className: "ai-apps-card" },
            h("h3", null, loading ? "Loading…" : (viewMode === "archive" ? "Archive is empty" : "No apps yet")),
            h("p", null, viewMode === "archive" ? "Archived apps will appear here. Delete from this view to permanently remove them." : "Create ~/.hermes/ai-apps/apps/<name>/ with index.html and manifest.json. Plugin-bundled apps under dist/apps are also shown."),
            viewMode === "active" ? h("p", null, "Use a meaningful slug; for throwaways use temp-<short-topic>.") : null
          )
        ),

        h("main", { className: "ai-apps-preview-wrap" },
          h("div", { className: "ai-apps-preview-bar" },
            h("code", { title: selectedUrl }, selected ? (selected.title || selectedSlug) + " — " + selectedUrl : "Select an app"),
            h("div", { className: "ai-apps-actions" },
              selectedSlug ? h("span", { className: "ai-apps-pill" }, selectedSlug) : null,
              selected && selected.archived ? h("span", { className: "ai-apps-pill" }, "archived") : null,
              selected && itemKind(selected) === "app" ? h("span", { className: "ai-apps-pill" }, "RPC bridge enabled") : null
            )
          ),
          selectedUrl ? h("iframe", {
            ref: frameRef,
            key: selectedUrl,
            className: "ai-apps-frame",
            src: selectedUrl,
            sandbox: "allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin",
            referrerPolicy: "no-referrer",
            title: selected ? selected.title : "AI App Preview",
          }) : h("div", { className: "ai-apps-empty" },
            h("div", null,
              h("h3", null, "Nothing selected"),
              h("p", null, "Pick an app from the list to preview it here, or open it full-screen.")
            )
          )
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("ai-apps", AIAppsPage);
})();
