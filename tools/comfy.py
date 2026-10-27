#!/usr/bin/env python3
"""Run the ComfyUI repo's own comfy.py from the workspace: same commands and options (see the comfyui-workflows skill).

The ComfyUI repo sits next to this workspace at ../comfyui/comfyui_workflows. This file only finds and starts its
script, so the workflows and the logic stay in that repo.

  python tools/comfy.py guide        print the ComfyUI repo's own skill (the full instructions)
  python tools/comfy.py status | list | inspect <workflow> | run <workflow> ... | result <prompt_id> | queue | free
"""
import runpy
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[2] / "comfyui" / "comfyui_workflows" / ".claude" / "skills" / "comfyui"
SCRIPT = SKILL / "scripts" / "comfy.py"

if not SCRIPT.is_file():
    sys.exit(f"The ComfyUI repo's comfy.py is missing ({SCRIPT}). Tell the user; do not write a comfy.py of your own.")
if sys.argv[1:2] == ["guide"]:
    sys.stdout.reconfigure(encoding="utf-8")
    print((SKILL / "SKILL.md").read_text(encoding="utf-8"))
    sys.exit(0)
sys.argv[0] = str(SCRIPT)
runpy.run_path(str(SCRIPT), run_name="__main__")
