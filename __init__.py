from __future__ import annotations

from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent


def register(ctx) -> None:
    """Register the companion AI Apps skill shipped with this plugin."""
    ctx.register_skill(
        name="ai-apps",
        path=PLUGIN_ROOT / "skills" / "ai-apps" / "SKILL.md",
        description=(
            "Create named AI Apps: static or serverless app-in-app artifacts "
            "for the Hermes dashboard."
        ),
    )
