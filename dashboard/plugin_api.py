from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

router = APIRouter()

PLUGIN_NAME = "ai-apps"
BASE_DIR = Path(__file__).resolve().parent
DIST_DIR = BASE_DIR / "dist"
SESSIONS_DIR = DIST_DIR / "sessions"
APPS_DIR = DIST_DIR / "apps"
ARCHIVE_DIR = DIST_DIR / "archive"
ARCHIVE_APPS_DIR = ARCHIVE_DIR / "apps"
ARCHIVE_SESSIONS_DIR = ARCHIVE_DIR / "sessions"
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()
USER_APPS_DIR = HERMES_HOME / "ai-apps" / "apps"
USER_ARCHIVE_APPS_DIR = HERMES_HOME / "ai-apps" / "archive" / "apps"
RPC_RUNNER = BASE_DIR / "rpc_runner.py"


@dataclass(frozen=True)
class AppRoot:
    name: str
    active_dir: Path
    archive_dir: Path


APP_ROOTS = (
    AppRoot("plugin", APPS_DIR, ARCHIVE_APPS_DIR),
    AppRoot("user", USER_APPS_DIR, USER_ARCHIVE_APPS_DIR),
)

_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
MAX_RPC_BODY_BYTES = 256 * 1024
RPC_TIMEOUT_SECONDS = 10


def _safe_json_load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _mtime_iso(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return ""


def _safe_child_dir(base: Path, name: str) -> Path:
    if not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="invalid guid")
    path = (base / name).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not path.exists() or not path.is_dir():
        raise HTTPException(status_code=404, detail="app not found")
    return path


def _resolve_app_dir(guid: str, *, archived: bool = False) -> tuple[Path, AppRoot]:
    """Resolve an app folder from the allowlisted app roots only."""
    if not _SAFE_NAME.match(guid):
        raise HTTPException(status_code=400, detail="invalid guid")
    for root in APP_ROOTS:
        base = root.archive_dir if archived else root.active_dir
        path = (base / guid).resolve()
        try:
            path.relative_to(base.resolve())
        except ValueError:
            continue
        if path.exists() and path.is_dir():
            return path, root
    raise HTTPException(status_code=404, detail="app not found")


def _safe_file_in_dir(base: Path, file_path: str) -> Path:
    clean = file_path.strip().lstrip("/")
    if not clean or ".." in Path(clean).parts:
        raise HTTPException(status_code=400, detail="invalid path")
    base = base.resolve()
    target = (base / clean).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return target


def _artifact_item(path: Path, *, kind: str, url_collection: str | None = None, source: str = "plugin") -> dict[str, Any] | None:
    if not path.is_dir():
        return None

    manifest_path = path / "manifest.json"
    meta = _safe_json_load(manifest_path) if manifest_path.exists() else {}

    entry = str(meta.get("entry") or "index.html").strip().lstrip("/")
    if not entry or ".." in Path(entry).parts:
        entry = "index.html"

    entry_path = path / entry
    if not entry_path.exists() or not entry_path.is_file():
        fallback = path / "index.html"
        if not fallback.exists():
            return None
        entry = "index.html"
        entry_path = fallback

    guid = path.name
    created_at = str(meta.get("created_at") or _mtime_iso(entry_path))
    tags = meta.get("tags") or []
    if not isinstance(tags, list):
        tags = []

    item = {
        "guid": str(meta.get("guid") or guid),
        "folder": guid,
        "source": source,
        "type": str(meta.get("type") or kind),
        "title": str(meta.get("title") or guid),
        "description": str(meta.get("description") or ""),
        "created_at": created_at,
        "updated_at": _mtime_iso(entry_path),
        "author": str(meta.get("author") or ""),
        "entry": entry,
        "tags": [str(tag) for tag in tags],
        "url": (
            f"/dashboard-plugins/{PLUGIN_NAME}/static/apps/{guid}/{entry}"
            if kind == "app"
            else f"/dashboard-plugins/{PLUGIN_NAME}/dist/{url_collection or 'sessions'}/{guid}/{entry}"
        ),
    }
    if kind == "app":
        server = meta.get("server") if isinstance(meta.get("server"), dict) else {}
        has_server = (path / str(server.get("entry") or "server.py")).exists()
        item["server"] = {
            "type": str(server.get("type") or "python-rpc"),
            "entry": str(server.get("entry") or "server.py"),
            "has_server": bool(has_server),
        }
    return item


def _list_artifacts(base: Path, *, kind: str, url_collection: str | None = None, source: str = "plugin") -> list[dict[str, Any]]:
    if not base.exists():
        return []
    items: list[dict[str, Any]] = []
    paths = sorted(base.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    for path in paths:
        item = _artifact_item(path, kind=kind, url_collection=url_collection, source=source)
        if item is not None:
            items.append(item)
    return items


def _list_app_roots(*, archived: bool = False) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in APP_ROOTS:
        base = root.archive_dir if archived else root.active_dir
        url_collection = "archive/apps" if archived else "apps"
        for item in _list_artifacts(base, kind="app", url_collection=url_collection, source=root.name):
            folder = str(item.get("folder") or "")
            if folder in seen:
                continue
            seen.add(folder)
            items.append(item)
    items.sort(key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True)
    return items


def _collection_config(collection: str, *, archived: bool = False) -> tuple[Path, str, str]:
    """Return (base_dir, kind, url_collection) for a public collection name."""
    if collection == "apps":
        return (ARCHIVE_APPS_DIR if archived else APPS_DIR, "app", "archive/apps" if archived else "apps")
    if collection == "sessions":
        return (ARCHIVE_SESSIONS_DIR if archived else SESSIONS_DIR, "static", "archive/sessions" if archived else "sessions")
    raise HTTPException(status_code=400, detail="invalid collection")


def _safe_archive_target(base: Path, name: str) -> Path:
    if not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="invalid guid")
    base = base.resolve()
    path = (base / name).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    return path


def _move_item(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise HTTPException(status_code=409, detail="target already exists")
    try:
        shutil.move(str(source), str(target))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"move failed: {exc}") from exc


@router.get("/sessions")
async def list_sessions() -> dict[str, Any]:
    """Return static UI artifacts dropped under dist/sessions/<guid>/."""
    return {"items": _list_artifacts(SESSIONS_DIR, kind="static")}


@router.get("/apps")
async def list_apps() -> dict[str, Any]:
    """Return serverless apps from plugin dist/apps and ~/.hermes/ai-apps/apps."""
    return {"items": _list_app_roots()}


@router.get("/archive")
async def list_archive() -> dict[str, Any]:
    """Return apps and legacy static artifacts hidden from the main lists."""
    apps = _list_app_roots(archived=True)
    for item in apps:
        item["collection"] = "apps"
        item["archived"] = True
    sessions = _list_artifacts(ARCHIVE_SESSIONS_DIR, kind="static", url_collection="archive/sessions")
    for item in sessions:
        item["collection"] = "sessions"
        item["archived"] = True
    return {"items": apps + sessions}


@router.post("/{collection}/{guid}/archive")
async def archive_item(collection: str, guid: str) -> dict[str, Any]:
    if collection == "apps":
        source, root = _resolve_app_dir(guid, archived=False)
        target = _safe_archive_target(root.archive_dir, source.name)
        _move_item(source, target)
        item = _artifact_item(target, kind="app", url_collection="archive/apps", source=root.name)
        return {"ok": True, "item": item}

    base, kind, _ = _collection_config(collection, archived=False)
    source = _safe_child_dir(base, guid)
    target_base, _, _ = _collection_config(collection, archived=True)
    target = _safe_archive_target(target_base, source.name)
    _move_item(source, target)
    item = _artifact_item(target, kind=kind, url_collection="archive/" + collection)
    return {"ok": True, "item": item}


@router.post("/archive/{collection}/{guid}/restore")
async def restore_archived_item(collection: str, guid: str) -> dict[str, Any]:
    if collection == "apps":
        source, root = _resolve_app_dir(guid, archived=True)
        target = _safe_archive_target(root.active_dir, source.name)
        _move_item(source, target)
        item = _artifact_item(target, kind="app", url_collection="apps", source=root.name)
        return {"ok": True, "item": item}

    archive_base, kind, _ = _collection_config(collection, archived=True)
    source = _safe_child_dir(archive_base, guid)
    active_base, _, _ = _collection_config(collection, archived=False)
    target = _safe_archive_target(active_base, source.name)
    _move_item(source, target)
    item = _artifact_item(target, kind=kind, url_collection=collection)
    return {"ok": True, "item": item}


@router.delete("/archive/{collection}/{guid}")
async def delete_archived_item(collection: str, guid: str) -> dict[str, Any]:
    if collection == "apps":
        target, _ = _resolve_app_dir(guid, archived=True)
    else:
        archive_base, _, _ = _collection_config(collection, archived=True)
        target = _safe_child_dir(archive_base, guid)
    try:
        shutil.rmtree(target)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"delete failed: {exc}") from exc
    return {"ok": True, "deleted": guid, "collection": collection}


@router.get("/apps/{guid}")
async def get_app(guid: str) -> dict[str, Any]:
    app_dir, root = _resolve_app_dir(guid)
    item = _artifact_item(app_dir, kind="app", source=root.name)
    if item is None:
        raise HTTPException(status_code=404, detail="app not found")
    return item


@router.get("/static/app-bridge.js")
async def get_app_bridge() -> FileResponse:
    bridge = _safe_file_in_dir(DIST_DIR, "app-bridge.js")
    return FileResponse(bridge)


@router.get("/static/apps/{guid}/{file_path:path}")
async def get_app_static_file(guid: str, file_path: str) -> FileResponse:
    app_dir, _ = _resolve_app_dir(guid)
    target = _safe_file_in_dir(app_dir, file_path)
    return FileResponse(target)


async def _rpc_payload(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > MAX_RPC_BODY_BYTES:
        raise HTTPException(status_code=413, detail="RPC request too large")
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}") from exc


def _runner_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for key in ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE"):
        if key in os.environ:
            env[key] = os.environ[key]
    env["PYTHONUNBUFFERED"] = "1"
    return env


@router.post("/apps/{guid}/rpc/{function_name}")
async def call_app_rpc(guid: str, function_name: str, request: Request) -> dict[str, Any]:
    """Call a per-app serverless Python function in a subprocess.

    Apps live under allowlisted app roots and may define server.py with:

        FUNCTIONS = {"name": callable}

    Preferred callable signature is fn(payload, context). The runner returns
    JSON only and has a short timeout so app code cannot hang the dashboard.
    """
    app_dir, _ = _resolve_app_dir(guid)
    if not _SAFE_NAME.match(function_name):
        raise HTTPException(status_code=400, detail="invalid function name")
    if not RPC_RUNNER.exists():
        raise HTTPException(status_code=500, detail="rpc runner missing")

    payload = await _rpc_payload(request)
    query = dict(request.query_params)
    runner_input = json.dumps({
        "method": request.method,
        "query": query,
        "payload": payload,
    }, ensure_ascii=False)

    try:
        proc = subprocess.run(
            [sys.executable, str(RPC_RUNNER), str(app_dir), guid, function_name],
            input=runner_input,
            text=True,
            capture_output=True,
            timeout=RPC_TIMEOUT_SECONDS,
            cwd=str(app_dir),
            env=_runner_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"RPC timed out after {RPC_TIMEOUT_SECONDS}s") from exc

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    try:
        data = json.loads(stdout) if stdout else {"ok": False, "error": "empty RPC response"}
    except Exception:
        data = {"ok": False, "error": "invalid JSON from RPC runner", "stdout": stdout[:2000]}

    if proc.returncode != 0 or not data.get("ok"):
        detail = data.get("error") or f"RPC failed with exit code {proc.returncode}"
        if stderr:
            data["stderr"] = stderr[:2000]
        raise HTTPException(status_code=500 if proc.returncode not in (2, 404) else 400, detail=data | {"error": detail})
    return data
