from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _ctx(context, key: str, default=None):
    """Support both new object-style context and older dict-style runner context."""
    if isinstance(context, dict):
        return context.get(key, default)
    return getattr(context, key, default)


def _data_path(context) -> Path:
    data_dir = _ctx(context, "data_dir") or (Path(_ctx(context, "app_dir", ".")) / "data")
    path = Path(data_dir) / "counter.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _load(context) -> dict[str, Any]:
    path = _data_path(context)
    if not path.exists():
        return {"count": 0, "events": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"count": 0, "events": []}


def _save(context, data: dict[str, Any]) -> dict[str, Any]:
    _data_path(context).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return data


def get_state(payload, context):
    data = _load(context)
    data["server_time"] = datetime.now(timezone.utc).isoformat()
    return data


def increment(payload, context):
    payload = payload or {}
    step = int(payload.get("step") or 1)
    data = _load(context)
    data["count"] = int(data.get("count") or 0) + step
    events = data.setdefault("events", [])
    events.insert(0, {"at": datetime.now(timezone.utc).isoformat(), "step": step, "count": data["count"]})
    del events[12:]
    return _save(context, data)


def reset(payload, context):
    return _save(context, {"count": 0, "events": []})


FUNCTIONS = {
    "get_state": get_state,
    "increment": increment,
    "reset": reset,
}
