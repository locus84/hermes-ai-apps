from __future__ import annotations

import asyncio
import inspect
import json
import os
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import importlib.util

sys.dont_write_bytecode = True
MAX_STDIN_BYTES = 256 * 1024


class AppContext(SimpleNamespace):
    guid: str
    app_dir: str
    data_dir: str
    method: str
    query: dict[str, Any]


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _emit(payload: dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=_json_default))
    sys.stdout.write("\n")
    raise SystemExit(code)


def _load_server(app_dir: Path):
    server_path = app_dir / "server.py"
    if not server_path.exists() or not server_path.is_file():
        _emit({"ok": False, "error": "server.py not found"}, 2)

    spec = importlib.util.spec_from_file_location(f"ai_apps_app_{app_dir.name}_server", server_path)
    if spec is None or spec.loader is None:
        _emit({"ok": False, "error": "failed to create import spec for server.py"}, 2)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _call_function(func: Any, payload: Any, context: AppContext) -> Any:
    # Preferred signature: fn(payload, context). Also accept fn(payload) or fn().
    sig = inspect.signature(func)
    positional = [
        p for p in sig.parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
        and p.default is p.empty
    ]
    if len(positional) >= 2:
        result = func(payload, context)
    elif len(positional) == 1:
        result = func(payload)
    else:
        result = func()
    if inspect.isawaitable(result):
        result = await result
    return result


async def _main() -> None:
    if len(sys.argv) != 4:
        _emit({"ok": False, "error": "usage: rpc_runner.py <app_dir> <guid> <function>"}, 2)

    app_dir = Path(sys.argv[1]).resolve()
    guid = sys.argv[2]
    function_name = sys.argv[3]

    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        _emit({"ok": False, "error": "request too large"}, 2)
    try:
        request = json.loads(raw.decode("utf-8") or "{}")
    except Exception as exc:
        _emit({"ok": False, "error": f"invalid JSON request: {exc}"}, 2)

    payload = request.get("payload")
    context = AppContext(
        guid=guid,
        app_dir=str(app_dir),
        data_dir=str(app_dir / "data"),
        method=str(request.get("method") or "POST"),
        query=request.get("query") if isinstance(request.get("query"), dict) else {},
    )

    try:
        module = _load_server(app_dir)
        functions = getattr(module, "FUNCTIONS", None)
        if not isinstance(functions, dict):
            _emit({"ok": False, "error": "server.py must define FUNCTIONS = {name: callable}"}, 2)
        func = functions.get(function_name)
        if not callable(func):
            _emit({"ok": False, "error": f"function not found: {function_name}"}, 404)
        result = await _call_function(func, payload, context)
        _emit({"ok": True, "result": result})
    except SystemExit:
        raise
    except Exception as exc:
        _emit({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(limit=8),
        }, 1)


if __name__ == "__main__":
    # Keep cwd and imports local to the app; avoid leaking Hermes secrets through env.
    for key in list(os.environ):
        upper = key.upper()
        if upper.startswith("HERMES_") or any(token in upper for token in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "ACCESS_KEY")):
            os.environ.pop(key, None)
    asyncio.run(_main())
