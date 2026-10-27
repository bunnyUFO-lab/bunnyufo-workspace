# WezTerm config

A WezTerm setup, kept in version control. `wezterm.lua` is the config;
`wezterm_custom_plugins/` holds its plugins (tab rename, session save/restore via
[resurrect.wezterm](https://github.com/MLFlexer/resurrect.wezterm)).

## Use it

Point `~/.wezterm.lua` at this folder (adjust `dir` to your clone):

```lua
local wezterm = require 'wezterm'
local dir = 'C:/Users/<you>/Workspace/bunnyufo-workspace/tools/wezterm'
package.path = dir .. '/?.lua;' .. package.path
wezterm.add_to_config_reload_watch_list(dir .. '/wezterm.lua')
return assert(loadfile(dir .. '/wezterm.lua'))(dir)
```

WezTerm reloads on save. Check a change without opening a window:
`wezterm show-keys --lua`.

## Workspace shortcuts

| Keys | Action |
|---|---|
| Ctrl+Shift+G | Bring up the bunnyUFO Workspace window (starts the installed app if needed) |
| Ctrl+Shift+A | New tab running `clau` (alias for `claude --dangerously-skip-permissions`) in the workspace root, with its skills, rules and MCP servers |
| Ctrl+Shift+E | New tab running `opencode` in the workspace root, defaulting to local Ollama models |
| Shift+Enter | Sends Alt+Enter: a new line in Claude Code, OpenCode and Copilot |

Other bindings (tabs, panes, sessions) are listed in `wezterm.lua` and the plugins.
