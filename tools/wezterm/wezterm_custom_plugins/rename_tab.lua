-- rename_tab.lua
-- Ctrl+T: prompt to rename the current tab.
-- Enter confirms, Esc cancels.

local wezterm = require 'wezterm'
local act = wezterm.action

local M = {}

function M.apply(config)
  table.insert(config.keys, {
    key = 't',
    mods = 'CTRL',
    action = act.PromptInputLine {
      description = 'Set tab title',
      action = wezterm.action_callback(function(window, pane, line)
        if line then
          window:active_tab():set_title(line)
        end
      end),
    },
  })
end

return M
