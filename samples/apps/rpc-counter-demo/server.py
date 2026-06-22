from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _ctx(context: Any, key: str, default=None):
    """Support both object-style and dict-style runner contexts."""
    if isinstance(context, dict):
        return context.get(key, default)
    return getattr(context, key, default)


def _state_path(context: Any) -> Path:
    data_dir = _ctx(context, "data_dir")
    if not data_dir:
        data_dir = Path(_ctx(context, "app_dir", ".")) / "data"
    path = Path(data_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path / "state.json"


def _read(context: dict[str, Any]) -> dict[str, Any]:
    path = _state_path(context)
    if not path.exists():
        return {"count": 0, "events": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"count": 0, "events": []}
    if not isinstance(data, dict):
        return {"count": 0, "events": []}
    data.setdefault("count", 0)
    data.setdefault("events", [])
    return data


def _write(context: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    _state_path(context).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return data


def get_state(payload: Any, context: dict[str, Any]) -> dict[str, Any]:
    return _read(context)


def increment(payload: Any, context: dict[str, Any]) -> dict[str, Any]:
    data = _read(context)
    amount = 1
    if isinstance(payload, dict):
        try:
            amount = int(payload.get("amount", 1))
        except Exception:
            amount = 1
    data["count"] = int(data.get("count", 0)) + amount
    events = list(data.get("events", []))
    events.insert(0, f"+{amount} -> {data['count']}")
    data["events"] = events[:8]
    return _write(context, data)


def reset(payload: Any, context: dict[str, Any]) -> dict[str, Any]:
    return _write(context, {"count": 0, "events": ["reset"]})


FUNCTIONS = {
    "get_state": get_state,
    "increment": increment,
    "reset": reset,
}
