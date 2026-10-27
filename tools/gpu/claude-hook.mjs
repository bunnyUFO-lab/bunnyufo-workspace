// Claude Code hook for Sprite Studio's MCP tools and shell commands (register it in your own Claude Code settings).
// PreToolUse: unload local Ollama models that would not fit beside the job the tool queues; a shell command that
//   runs a ComfyUI workflow with the ComfyUI repo's comfy.py unloads all of them.
// PostToolUse (wait_for_job / job_status): copy a finished job into the Pixel Art Studio gallery.
// Never blocks a tool: it always exits 0.
import { beforeComfyRun, beforeSpriteStudioTool, isComfyRun, JOB_TOOLS, recordGallery, spriteStudioTool } from './guard.mjs'

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

try {
  const event = JSON.parse(raw || '{}')
  const tool = spriteStudioTool(event.tool_name)
  const args = event.tool_input ?? {}
  if (tool && event.hook_event_name === 'PreToolUse') {
    await beforeSpriteStudioTool(tool, args)
  } else if (tool && event.hook_event_name === 'PostToolUse' && JOB_TOOLS.has(tool)) {
    await recordGallery(args.job_id)
  } else if (SHELL_TOOLS.has(event.tool_name) && event.hook_event_name === 'PreToolUse' && isComfyRun(args.command)) {
    await beforeComfyRun()
  }
} catch (error) {
  process.stderr.write(`gpu hook: ${error.message ?? error}\n`)
}
process.exit(0)
