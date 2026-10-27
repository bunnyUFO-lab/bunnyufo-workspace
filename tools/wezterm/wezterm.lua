-- WezTerm config, version-controlled in Game Dev Workspace (tools/wezterm).
-- ~/.wezterm.lua loads this file and passes its folder; see README.md.
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

local here = (... or wezterm.config_dir):gsub('\\', '/')
local workspace_root = here:gsub('/tools/wezterm/?$', '')
local bash = 'C:/Program Files/Git/bin/bash.exe'
local workspace_app = (os.getenv('LOCALAPPDATA') or ''):gsub('\\', '/') .. '/Game Dev Workspace/game-dev-workspace.exe'

config.default_prog = { bash, '--login', '-i' }

config.ssh_domains = {
  {
    name = 'wks',
    remote_address = 'localhost:2222',
    username = 'dev',
    multiplexing = 'WezTerm',
  },
}

local keys = {
  -- Make Shift+Enter act like Alt+Enter (new line in Copilot, Claude Code and OpenCode)
  {
    key = 'Enter',
    mods = 'SHIFT',
    action = wezterm.action.SendKey { key = 'Enter', mods = 'ALT' },
  },
  {
    key = 'F11',
    mods = '',
    action = wezterm.action.ToggleFullScreen,
  },
}

-- Ctrl+[0-9] to switch tabs (0 = tab 10)
for i = 0, 9 do
  table.insert(keys, {
    key = tostring(i),
    mods = 'CTRL',
    action = wezterm.action.ActivateTab(i == 0 and 9 or i - 1),
  })
end

-- Ctrl+u/i to move tab left/right
table.insert(keys, { key = 'u', mods = 'CTRL', action = wezterm.action.MoveTabRelative(-1) })
table.insert(keys, { key = 'i', mods = 'CTRL', action = wezterm.action.MoveTabRelative(1) })

-- Ctrl+Shift+IJKL to move between panes (I=up, J=left, K=down, L=right)
table.insert(keys, { key = 'I', mods = 'CTRL|SHIFT', action = wezterm.action.ActivatePaneDirection 'Up' })
table.insert(keys, { key = 'J', mods = 'CTRL|SHIFT', action = wezterm.action.ActivatePaneDirection 'Left' })
table.insert(keys, { key = 'K', mods = 'CTRL|SHIFT', action = wezterm.action.ActivatePaneDirection 'Down' })
table.insert(keys, { key = 'L', mods = 'CTRL|SHIFT', action = wezterm.action.ActivatePaneDirection 'Right' })

-- Ctrl+Shift+W = connect to wks SSH domain
table.insert(keys, { key = 'W', mods = 'CTRL|SHIFT', action = wezterm.action.AttachDomain 'wks' })

-- Ctrl+Shift+O = split down, Ctrl+Shift+P = split right
table.insert(keys, { key = 'O', mods = 'CTRL|SHIFT', action = wezterm.action.SplitPane { direction = 'Down' } })
table.insert(keys, { key = 'P', mods = 'CTRL|SHIFT', action = wezterm.action.SplitPane { direction = 'Right' } })

-- Ctrl+j/k/l/; to switch to tabs 1/2/3/4
for i, k in ipairs({ 'j', 'k', 'l', ';' }) do
  table.insert(keys, {
    key = k,
    mods = 'CTRL',
    action = wezterm.action.ActivateTab(i - 1),
  })
end

-- Ctrl+Shift+G = bring up the Game Dev Workspace window (starts the app if needed;
-- a running app is single-instance and just shows its window)
table.insert(keys, {
  key = 'G',
  mods = 'CTRL|SHIFT',
  action = wezterm.action_callback(function()
    wezterm.background_child_process { workspace_app, '--show', 'workspace' }
  end),
})

-- Ctrl+Shift+A = new tab with Claude Code in the workspace (loads its skills, rules and MCP servers);
-- clau is a bash alias for claude --dangerously-skip-permissions
table.insert(keys, {
  key = 'A',
  mods = 'CTRL|SHIFT',
  action = wezterm.action_callback(function(window)
    local _, pane = window:mux_window():spawn_tab { cwd = workspace_root }
    pane:send_text('clau\r')
  end),
})

-- Ctrl+Shift+E = new tab with OpenCode in the workspace; its opencode.json defaults to local Ollama models
-- (the workspace's GPU plugin frees ComfyUI before a local model answers)
table.insert(keys, {
  key = 'E',
  mods = 'CTRL|SHIFT',
  action = wezterm.action_callback(function(window)
    local _, pane = window:mux_window():spawn_tab { cwd = workspace_root }
    pane:send_text('opencode\r')
  end),
})

config.keys = keys

-- Custom plugins
require('wezterm_custom_plugins.rename_tab').apply(config)
require('wezterm_custom_plugins.session_manager').apply(config)

return config
