-- Quarto's filter runtime is intentionally the only discovery point for the
-- local bridge. The browser never receives a temp-directory listing capability.
local PREFIX = 'collab-comments-preview-'

local function starts_with(value, prefix)
  return value and prefix and value:sub(1, #prefix) == prefix
end

local function normalize(value)
  local normalized = (value or ''):gsub('\\', '/'):gsub('/+', '/')
  -- macOS exposes its temporary directory through both /var and /private/var.
  -- Node and Quarto can independently choose either spelling for the same inode.
  return normalized:gsub('^/private/var/', '/var/')
end

local function is_absolute(value)
  if pandoc.path and pandoc.path.is_absolute then
    local ok, result = pcall(pandoc.path.is_absolute, value)
    if ok then return result end
  end
  return value:sub(1, 1) == '/' or value:match('^%a:[/\\]') ~= nil
end

local function join_path(left, right)
  if pandoc.path and pandoc.path.join then return pandoc.path.join({left, right}) end
  return left .. '/' .. right
end

local function boolean(value, default)
  if value == nil then return default end
  return pandoc.utils.stringify(value):lower() == 'true'
end

local function config_value(meta, key, default)
  local config = meta['collab-comments']
  if config and config[key] ~= nil then return boolean(config[key], default) end
  return default
end

local function current_input()
  local input = quarto.doc.input_file or (PANDOC_STATE.input_files and PANDOC_STATE.input_files[1]) or ''
  if not is_absolute(input) then
    local root = quarto.project.directory or pandoc.system.get_working_directory()
    input = join_path(root, input)
  end
  return normalize(input)
end

local function trim(value)
  return (value or ''):gsub('^%s+', ''):gsub('%s+$', '')
end

-- The descriptor directory is a security boundary. On Unix, don't even list
-- it unless it is owned by the rendering user and private to that user. Node
-- creates this directory as 0700; Windows relies on its per-user TEMP ACLs.
local function trusted_descriptor_directory(directory)
  if package.config:sub(1, 1) == '\\' then return true end
  local exists = pcall(pandoc.pipe, 'test', {'-d', directory}, '')
  if not exists then return false end
  local uid_ok, uid = pcall(pandoc.pipe, 'id', {'-u'}, '')
  if not uid_ok then return false end
  local stat_args
  if pandoc.system.os == 'darwin' then
    stat_args = {'-f', '%u/%Lp', directory}
  else
    stat_args = {'-c', '%u/%a', directory}
  end
  local stat_ok, details = pcall(pandoc.pipe, 'stat', stat_args, '')
  if not stat_ok then return false end
  local owner, mode = trim(details):match('^(%d+)/(%d+)$')
  return owner == trim(uid) and mode == '700'
end

local function live_descriptor(input)
  local seen = {}
  local candidates = {}
  for _, value in ipairs({'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'TMP'}) do
    local temp = os.getenv(value)
    if temp then table.insert(candidates, temp) end
  end
  table.insert(candidates, '/tmp')
  for _, temp in ipairs(candidates) do
    if temp and not seen[temp] then
      seen[temp] = true
      local directory = join_path(temp, 'collab-comments-preview')
      local ok, entries = false, nil
      if trusted_descriptor_directory(directory) then
        ok, entries = pcall(pandoc.system.list_directory, directory)
      end
      if ok then for _, entry in ipairs(entries) do
        if starts_with(entry, PREFIX) and entry:match('%.json$') then
          local file = io.open(join_path(directory, entry), 'r')
          if file then
            local raw = file:read('*a')
            file:close()
            local decoded, descriptor = pcall(pandoc.json.decode, raw)
            if not decoded or type(descriptor) ~= 'table' then descriptor = nil end
            local workspace = descriptor and type(descriptor.workspace) == 'string' and normalize(descriptor.workspace)
            local port = descriptor and descriptor.endpoint and descriptor.endpoint:match('^http://127%.0%.0%.1:(%d+)$')
            if decoded and descriptor and descriptor.schemaVersion == 1 and port and tonumber(port) > 0 and tonumber(port) < 65536
              and workspace and workspace ~= '' and is_absolute(workspace) and starts_with(input, workspace .. '/') and descriptor.endpoint
              and type(descriptor.token) == 'string' and #descriptor.token == 43 and descriptor.token:match('^[A-Za-z0-9_-]+$') and type(descriptor.expiresAt) == 'string' then
              -- ISO strings compare lexically in the format written by the extension.
              if descriptor.expiresAt > os.date('!%Y-%m-%dT%H:%M:%S') then return descriptor end
            end
          end
        end
      end end
    end
  end
  return nil
end

local function exported_comments(workspace, input, show_resolved)
  workspace = normalize(workspace)
  local root = workspace
  local directory = normalize(input):match('^(.*)/[^/]+$') or workspace
  local file
  while directory and directory ~= '' do
    root = directory
    file = io.open(join_path(join_path(root, '.comments'), 'collab-comments.json'), 'r')
    if file then break end
    local parent = directory:match('^(.*)/[^/]+$')
    if not parent or parent == directory then file = nil break end
    directory = parent
  end
  if not file then return {} end
  local raw = file:read('*a')
  file:close()
  local ok, store = pcall(pandoc.json.decode, raw)
  if not ok or type(store) ~= 'table' or type(store.comments) ~= 'table' then return {} end
  local function valid_position(position)
    return type(position) == 'table'
      and type(position.line) == 'number' and position.line >= 0 and position.line == math.floor(position.line)
      and type(position.character) == 'number' and position.character >= 0 and position.character == math.floor(position.character)
  end
  local function valid_array(items, valid_item)
    if type(items) ~= 'table' then return false end
    for key, item in pairs(items) do
      if type(key) ~= 'number' or key < 1 or key ~= math.floor(key) or not valid_item(item) then return false end
    end
    return true
  end
  local function valid_reply(reply)
    return type(reply) == 'table' and type(reply.id) == 'string' and type(reply.author) == 'string'
      and type(reply.timestamp) == 'string' and type(reply.text) == 'string'
  end
  local function valid_change(change)
    return type(change) == 'table' and type(change.id) == 'string' and type(change.author) == 'string'
      and type(change.timestamp) == 'string' and type(change.previousText) == 'string' and type(change.newText) == 'string'
  end
  local function valid_comment(comment)
    if type(comment) ~= 'table' or type(comment.id) ~= 'string' or type(comment.author) ~= 'string'
      or type(comment.timestamp) ~= 'string' or type(comment.text) ~= 'string' or type(comment.filePath) ~= 'string'
      or type(comment.range) ~= 'table' or not valid_position(comment.range.start) or not valid_position(comment.range['end']) then return false end
    if comment.selectedText ~= nil and type(comment.selectedText) ~= 'string' then return false end
    if comment.contextBefore ~= nil and type(comment.contextBefore) ~= 'string' then return false end
    if comment.contextAfter ~= nil and type(comment.contextAfter) ~= 'string' then return false end
    if comment.documentHash ~= nil and type(comment.documentHash) ~= 'string' then return false end
    if comment.resolved ~= nil and type(comment.resolved) ~= 'boolean' then return false end
    if comment.replies ~= nil and not valid_array(comment.replies, valid_reply) then return false end
    if comment.trackedChanges ~= nil and not valid_array(comment.trackedChanges, valid_change) then return false end
    return true
  end
  local relative = normalize(input):sub(#root + 2)
  local result = {}
  for _, comment in ipairs(store.comments) do
    if valid_comment(comment) and comment.filePath == relative and (show_resolved or not comment.resolved) then
      table.insert(result, comment)
    end
  end
  return result
end

local function config_script(settings)
  local json = pandoc.json.encode(settings)
  json = json:gsub('&', '\\u0026'):gsub('<', '\\u003c'):gsub('>', '\\u003e')
  json = json:gsub('\226\128\168', '\\u2028'):gsub('\226\128\169', '\\u2029')
  return '<script type="application/json" id="collab-comments-config">' .. json .. '</script>'
end

function Pandoc(doc)
  if not quarto.doc.is_format('html') or quarto.doc.is_format('revealjs') or quarto.doc.is_format('dashboard') then return doc end
  local input = current_input()
  local workspace = normalize(quarto.project.directory or pandoc.system.get_working_directory())
  local export = config_value(doc.meta, 'export', false)
  local show_resolved = config_value(doc.meta, 'show-resolved', false)
  -- Exports deliberately have no bridge endpoint: even an export produced
  -- during `quarto preview` must remain a read-only static artifact.
  local descriptor = not export and live_descriptor(input) or nil
  if not descriptor and not export then return doc end

  quarto.doc.add_html_dependency({
    name = 'collab-comments', version = '0.1.0',
    scripts = {'collab-comments.js'}, stylesheets = {'collab-comments.css'}
  })
  local settings = {
    bridge = descriptor and {endpoint = descriptor.endpoint} or nil, export = export,
    showResolved = show_resolved, comments = export and exported_comments(workspace, input, show_resolved) or {}
  }
  table.insert(doc.blocks, 1, pandoc.RawBlock('html', config_script(settings)))
  return doc
end
