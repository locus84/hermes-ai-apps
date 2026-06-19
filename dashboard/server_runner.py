from __future__ import annotations

"""Subprocess runner for AI Apps per-app serverless functions.

Protocol:
  stdin JSON: {"app_dir": "...", "function": "name", "payload": {...}}
  stdout JSON: {"ok": true, "result": ...} or {"ok": false, "error": "..."}

Each app may provide server.py with a module-level FUNCTIONS dict. Handlers may
be sync or async and should accept either (payload, context) or (payload).
"""

import asyncio
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import traceback
from typing import Any

MAX_STDIN_BYTES = 256 * 1024


class RunnerError(Exception):
    pass


def _emit(obj: dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    raise SystemExit(code)


def _safe_app_dir(raw: str) -> Path:
    path = Path(raw).resolve()
    if not path.exists() or not path.is_dir():
        raise RunnerError("app directory does not exist")
    return path


def _load_server(app_dir: Path) -> Any:
    server_path = app_dir / "server.py"
    if not server_path.exists() or not server_path.is_file():
        raise RunnerError("server.py not found for app")

    # Load with a unique module name to avoid cross-app/module cache reuse.
    module_name = "ai_apps_app_" + app_dir.name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(module_name, server_path)
    if spec is None or spec.loader is None:
        raise RunnerError("failed to create import spec for server.py")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(app_dir))
    old_cwd = os.getcwd()
    os.chdir(app_dir)
    try:
        spec.loader.exec_module(module)
    finally:
        os.chdir(old_cwd)
        try:
            sys.path.remove(str(app_dir))
        except ValueError:
            pass
    return module


async def _call_handler(handler: Any, payload: Any, context: dict[str, Any]) -> Any:
    if not callable(handler):
        raise RunnerError("server function is not callable")

    try:
        sig = inspect.signature(handler)
        params = list(sig.parameters.values())
        if len(params) >= 2:
            result = handler(payload, context)
        else:
            result = handler(payload)
    except TypeError:
        # Backward-friendly fallback for handlers that accept no args.
        result = handler()

    if inspect.isawaitable(result):
        result = await result
    return result


async def _main() -> None:
    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        raise RunnerError("request body too large")
    try:
        request = json.loads(raw.decode("utf-8") or "{}")
    except Exception as exc:
        raise RunnerError(f"invalid runner request JSON: {exc}") from exc

    app_dir = _safe_app_dir(str(request.get("app_dir") or ""))
    function_name = str(request.get("function") or "")
    if not function_name.replace("_", "").replace("-", "").isalnum():
        raise RunnerError("invalid function name")

    module = _load_server(app_dir)
    functions = getattr(module, "FUNCTIONS", None)
    if not isinstance(functions, dict):
        raise RunnerError("server.py must define FUNCTIONS = {...}")
    if function_name not in functions:
        raise RunnerError(f"function not found: {function_name}")

    context = {
        "app_dir": str(app_dir),
        "data_dir": str(app_dir / "data"),
        "guid": app_dir.name,
    }
    result = await _call_handler(functions[function_name], request.get("payload"), context)
    _emit({"ok": True, "result": result})


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except RunnerError as exc:
        _emit({"ok": False, "error": str(exc)}, code=2)
    except SystemExit:
        raise
    except Exception as exc:
        _emit({"ok": False, "error": f"server function failed: {exc}", "traceback": traceback.format_exc(limit=8)}, code=1)
