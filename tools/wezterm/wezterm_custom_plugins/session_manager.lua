-- session_manager.lua
-- Session save/restore/delete using resurrect.wezterm
--
-- Ctrl+Shift+S: Save current window as a session (prompts for name if new)
-- Ctrl+Shift+R: Session manager (restore or delete sessions)
--
-- Ctrl+Shift+Q: Graceful quit (exit claude panes, save, quit)
--
-- Saves are per-window, not per-workspace.
-- Auto-resumes claude sessions on restore.

local wezterm = require 'wezterm'
local resurrect = wezterm.plugin.require('https://github.com/MLFlexer/resurrect.wezterm')

local M = {}

-- Maps mux_window_id → session name (tracks which window belongs to which session)
local window_session = {}

-- Save a single window's state under a given name
local function save_window(gui_win, name)
  local mux_win = gui_win:mux_window()
  local state = resurrect.window_state.get_window_state(mux_win)
  resurrect.state_manager.save_state(state, name)
end

-- Extract the last claude --resume command from the last 50 lines of pane text
local function find_resume_id(text)
  if not text then return nil end
  local lines = {}
  for line in text:gmatch('[^\n]+') do
    table.insert(lines, line)
  end
  local start = math.max(1, #lines - 49)
  local tail = {}
  for i = start, #lines do
    table.insert(tail, lines[i])
  end
  local chunk = table.concat(tail, '\n')
  local clean = chunk:gsub('\x1b[^a-zA-Z]*[a-zA-Z]', ''):gsub('\x1b%([AB0-9]', '')
  local last_id = nil
  for id in clean:gmatch('claude %-%-resume%s+([%x%-]+)') do
    last_id = id
  end
  return last_id
end

-- Write pane text to a temp file so it can be cat'd after bash loads
local function save_pane_text_to_file(text)
  if not text then return nil end
  -- Get last 80 lines
  local lines = {}
  for line in text:gmatch('[^\n]+') do
    table.insert(lines, line)
  end
  local start = math.max(1, #lines - 79)
  local tail = {}
  for i = start, #lines do
    table.insert(tail, lines[i])
  end
  -- Strip ANSI escapes for clean display
  local clean = table.concat(tail, '\n')
  clean = clean:gsub('\x1b[^a-zA-Z]*[a-zA-Z]', ''):gsub('\x1b%([AB0-9]', '')
  clean = clean:gsub('%s+$', '')

  local tmp = os.tmpname()
  local f = io.open(tmp, 'w')
  if f then
    f:write(clean)
    f:close()
    return tmp
  end
  return nil
end

-- Custom on_pane_restore: saves text to temp file and queues commands in input buffer.
-- send_text goes into the input buffer and bash executes it after it finishes loading.
local function on_pane_restore(pane_tree)
  local pane = pane_tree.pane

  if pane_tree.alt_screen_active then
    pane:send_text(wezterm.shell_join_args(pane_tree.process.argv) .. '\r\n')
  elseif pane_tree.text then
    -- Save text to temp file
    local tmp = save_pane_text_to_file(pane_tree.text)
    local resume_id = find_resume_id(pane_tree.text)

    -- Queue commands in input buffer — bash will execute after it finishes loading
    if tmp then
      pane:send_text('cat "' .. tmp .. '"; rm -f "' .. tmp .. '"\r\n')
    end
    if resume_id then
      pane:send_text('clau --resume ' .. resume_id .. '\r\n')
    end
  end
end

-- Restore a session by type and name into the current window
local function restore_session(win, pane, type, name)
  local opts = {
    relative = true,
    restore_text = true,
    close_open_tabs = true,
    close_open_panes = true,
    on_pane_restore = on_pane_restore,
  }
  if type == 'window' then
    local state = resurrect.state_manager.load_state(name, 'window')
    resurrect.window_state.restore_window(pane:window(), state, opts)
  elseif type == 'workspace' then
    local state = resurrect.state_manager.load_state(name, 'workspace')
    resurrect.workspace_state.restore_workspace(state, opts)
  elseif type == 'tab' then
    local state = resurrect.state_manager.load_state(name, 'tab')
    resurrect.tab_state.restore_tab(pane:tab(), state, opts)
  end
end

-- Scan the state directory and build choices with restore + delete entries
local function build_choices()
  local choices = {}
  local state_dir = resurrect.state_manager.save_state_dir
  local type_icons = {
    window = wezterm.nerdfonts.cod_browser .. ' ',
    workspace = wezterm.nerdfonts.cod_window .. ' ',
    tab = wezterm.nerdfonts.cod_layout .. ' ',
  }

  local del_choices = {}

  table.insert(choices, {
    id = '__header__',
    label = wezterm.format({
      { Attribute = { Intensity = 'Bold' } },
      { Foreground = { AnsiColor = 'Green' } },
      { Text = '── Restore ──' },
    }),
  })

  for _, type in ipairs({ 'window', 'workspace', 'tab' }) do
    local dir = state_dir .. type
    local ok, entries = pcall(wezterm.read_dir, dir)
    if ok and entries then
      for _, path in ipairs(entries) do
        local file = string.match(path, '[/\\]([^/\\]+)$')
        if file and file:match('%.json$') then
          local name = file:match('(.+)%..+$')
          local icon = type_icons[type] or ''
          table.insert(choices, {
            id = 'restore:' .. type .. ':' .. name,
            label = icon .. name,
          })
          table.insert(del_choices, {
            id = 'del:' .. type .. ':' .. name,
            label = wezterm.format({
              { Foreground = { AnsiColor = 'Red' } },
              { Text = '[del] ' .. name },
            }),
          })
        end
      end
    end
  end

  if #del_choices > 0 then
    table.insert(choices, {
      id = '__header__',
      label = wezterm.format({
        { Attribute = { Intensity = 'Bold' } },
        { Foreground = { AnsiColor = 'Red' } },
        { Text = '── Delete ──' },
      }),
    })
    for _, c in ipairs(del_choices) do
      table.insert(choices, c)
    end
  end

  return choices
end

-- Show the session picker
local function show_session_picker(win, pane)
  local choices = build_choices()

  if #choices == 0 then
    return
  end

  win:perform_action(
    wezterm.action.InputSelector {
      action = wezterm.action_callback(function(sel_win, sel_pane, id, label)
        if not id or id == '__header__' then
          return
        end
        local action, type, name = id:match('^(%a+):(%a+):(.+)$')
        if action == 'restore' then
          local mux_win = sel_win:mux_window()
          window_session[mux_win:window_id()] = name
          restore_session(sel_win, sel_pane, type, name)
        elseif action == 'del' then
          local file_id = type .. '\\' .. name .. '.json'
          resurrect.state_manager.delete_state(file_id)
          show_session_picker(sel_win, sel_pane)
        end
      end),
      title = 'Session Manager',
      description = 'Enter = restore/delete, type "del" to filter delete entries, Esc = cancel',
      fuzzy_description = 'Search sessions: ',
      choices = choices,
      fuzzy = true,
    },
    pane
  )
end

-- Collect all panes across all windows and tabs
local function get_all_panes()
  local panes = {}
  for _, gui_win in ipairs(wezterm.gui.gui_windows()) do
    local mux_win = gui_win:mux_window()
    for _, tab in ipairs(mux_win:tabs()) do
      for _, pane_info in ipairs(tab:panes_with_info()) do
        table.insert(panes, pane_info.pane)
      end
    end
  end
  return panes
end

-- Check if a pane is running claude
-- Claude runs as python.exe via uv, so check process name path for uv/python
-- and also check the pane title or process args for "claude"
local function is_claude_pane(pane)
  local name = pane:get_foreground_process_name()
  if not name then return false end
  name = name:lower()
  -- Direct match (in case it ever runs as claude.exe)
  if name:match('claude') then return true end
  -- Claude runs as python via uv — check if it's a uv-managed python
  if name:match('uv') and name:match('python') then return true end
  -- Check pane title for claude
  local title = pane:get_title()
  if title and title:lower():match('claude') then return true end
  return false
end

-- Save all windows that have a tracked session name
local function save_all_named_windows()
  for _, gui_win in ipairs(wezterm.gui.gui_windows()) do
    local mux_win = gui_win:mux_window()
    local name = window_session[mux_win:window_id()]
    if name then
      save_window(gui_win, name)
    end
  end
end

function M.apply(config)
  config.window_close_confirmation = 'NeverPrompt'

  -- Show errors as toast notifications for debugging
  wezterm.on('resurrect.error', function(err)
    local gui = wezterm.gui.gui_windows()
    if #gui > 0 then
      gui[1]:toast_notification('WezTerm resurrect error', tostring(err), nil, 4000)
    end
  end)

  -- Save session: quick-save if window has a name, otherwise prompt
  table.insert(config.keys, {
    key = 'S',
    mods = 'CTRL|SHIFT',
    action = wezterm.action_callback(function(win, pane)
      local mux_win = win:mux_window()
      local name = window_session[mux_win:window_id()]
      if name then
        -- Verify the saved file still exists on disk
        local state_dir = resurrect.state_manager.save_state_dir
        local path = state_dir .. 'window/' .. name .. '.json'
        local f = io.open(path, 'r')
        if f then
          f:close()
          save_window(win, name)
        else
          -- File was deleted, clear tracking and prompt for new name
          window_session[mux_win:window_id()] = nil
          name = nil
        end
      end
      if not name then
        win:perform_action(
          wezterm.action.PromptInputLine {
            description = 'Save window session as:',
            action = wezterm.action_callback(function(inner_win, inner_pane, line)
              if line == nil or line == '' then
                return
              end
              save_window(inner_win, line)
              local inner_mux = inner_win:mux_window()
              window_session[inner_mux:window_id()] = line
            end),
          },
          pane
        )
      end
    end),
  })

  -- Session manager: restore or delete
  table.insert(config.keys, {
    key = 'R',
    mods = 'CTRL|SHIFT',
    action = wezterm.action_callback(function(win, pane)
      show_session_picker(win, pane)
    end),
  })

  -- Graceful quit: exit claude on all panes, save named sessions, quit
  -- Uses chained events since call_after doesn't work inside InputSelector callbacks
  -- but DOES work inside action_callback keybinding handlers
  table.insert(config.keys, {
    key = 'Q',
    mods = 'CTRL|SHIFT',
    action = wezterm.action_callback(function(win, pane)
      local panes = get_all_panes()

      -- First Ctrl+C to all claude panes
      local has_claude = false
      for _, p in ipairs(panes) do
        if is_claude_pane(p) then
          p:send_text('\x03')
          has_claude = true
        end
      end

      if not has_claude then
        -- No claude running, just save and quit immediately
        save_all_named_windows()
        win:perform_action(wezterm.action.QuitApplication, pane)
        return
      end

      -- Second Ctrl+C after 0.3s, then save after 0.8s more, then quit
      wezterm.time.call_after(0.3, function()
        -- Second Ctrl+C
        for _, p in ipairs(panes) do
          if is_claude_pane(p) then
            p:send_text('\x03')
          end
        end

        -- Wait 0.8s for claude to exit and print resume text, then save and quit
        wezterm.time.call_after(0.8, function()
          save_all_named_windows()

          wezterm.time.call_after(0.5, function()
            win:perform_action(wezterm.action.QuitApplication, pane)
          end)
        end)
      end)
    end),
  })

end

return M
