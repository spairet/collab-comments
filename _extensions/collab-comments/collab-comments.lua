-- Quarto's filter runtime is intentionally the only discovery point for the
-- local bridge. The browser never receives a temp-directory listing capability.
local PREFIX = 'collab-comments-preview-'
local MAX_FILTER_READ_BYTES = 20 * 1024 * 1024

-- Do not ask Lua to allocate or decode an unbounded file supplied through a
-- workspace. The store and source are both untrusted at this boundary.
local function read_file_limited(path, description)
  local file = io.open(path, 'rb')
  if not file then return nil, 'unable to open ' .. description end
  local size_ok, size = pcall(file.seek, file, 'end')
  if not size_ok or type(size) ~= 'number' then
    file:close()
    return nil, 'unable to determine ' .. description .. ' size'
  end
  if size > MAX_FILTER_READ_BYTES then
    file:close()
    return nil, description .. ' exceeds 20 MiB limit'
  end
  local reset_ok = pcall(file.seek, file, 'set', 0)
  if not reset_ok then
    file:close()
    return nil, 'unable to read ' .. description
  end
  local content = file:read('*a')
  file:close()
  if type(content) ~= 'string' then return nil, 'unable to read ' .. description end
  return content
end

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
  local store_path
  while directory and directory ~= '' do
    root = directory
    local candidate = join_path(join_path(root, '.comments'), 'collab-comments.json')
    local file = io.open(candidate, 'rb')
    if file then
      file:close()
      store_path = candidate
      break
    end
    local parent = directory:match('^(.*)/[^/]+$')
    if not parent or parent == directory then break end
    directory = parent
  end
  if not store_path then return {} end
  local raw, read_error = read_file_limited(store_path, 'comment store')
  if not raw then
    io.stderr:write('[collab-comments] skipped comment export: ' .. read_error .. '\n')
    return {}
  end
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
  -- Reject a malformed collection as a whole. Do not turn a partial parse of
  -- an untrusted store into an export containing a possibly unrelated entry.
  if not valid_array(store.comments, valid_comment) then return {} end
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

local function warning(input, comment, reason)
  io.stderr:write(string.format('[collab-comments] %s:%d: skipped Word comment %s: %s\n',
    input, (comment.range and comment.range.start and comment.range.start.line or 0) + 1,
    comment.id or '?', reason))
end

local function source_lines(input)
  local text, read_error = read_file_limited(input, 'QMD source')
  if not text then return nil, read_error end
  local lines = {}
  for line in (text .. '\n'):gmatch('(.-)\n') do table.insert(lines, line) end
  return lines
end

-- VS Code stores UTF-16 characters; Lua string slicing uses UTF-8 byte
-- offsets. Return a byte index only at a valid UTF-16 boundary.
local function utf16_byte_index(text, character)
  if character == 0 then return 1 end
  local units, byte = 0, 1
  while byte <= #text do
    local codepoint = utf8.codepoint(text, byte)
    local width = codepoint and codepoint > 0xffff and 2 or 1
    if units + width > character then return nil end
    units = units + width
    byte = utf8.offset(text, 2, byte) or (#text + 1)
    if units == character then return byte end
  end
  return units == character and #text + 1 or nil
end

local function selected_source_text(lines, comment)
  if type(comment.selectedText) ~= 'string' then
    return nil, 'legacy comment has no stored selection text'
  end
  local start, finish = comment.range.start, comment.range['end']
  if start.line ~= finish.line then return nil, 'selection spans source lines' end
  local line = lines[start.line + 1]
  if line == nil then return nil, 'source line no longer exists' end
  local from, to = utf16_byte_index(line, start.character), utf16_byte_index(line, finish.character)
  if not from or not to or to < from then return nil, 'invalid source range' end
  local selected = line:sub(from, to - 1)
  if selected == '' or selected ~= comment.selectedText then
    return nil, 'stored selection is stale or not literal source text'
  end
  return selected
end

local function transcript(comment)
  -- The opening is always first. Activity is chronological; timestamps use
  -- direct UTF-8 byte ordinal comparison (the TS side compares UTF-8 buffers),
  -- never locale-sensitive collation. Ties are Reply
  -- then Tracked change, retaining their original insertion order within a kind.
  local entries = {{timestamp = comment.timestamp, kind = 'Opening comment', author = comment.author, text = comment.text}}
  local activity = {}
  for order, reply in ipairs(comment.replies or {}) do
    table.insert(activity, {timestamp = reply.timestamp, kind = 'Reply', kind_rank = 1, order = order,
      author = reply.author, text = reply.text})
  end
  for order, change in ipairs(comment.trackedChanges or {}) do
    table.insert(activity, {timestamp = change.timestamp, kind = 'Tracked change', kind_rank = 2, order = order,
      author = change.author,
      text = 'Previous: ' .. change.previousText .. '\nCurrent: ' .. change.newText})
  end
  table.sort(activity, function(left, right)
    if left.timestamp ~= right.timestamp then return left.timestamp < right.timestamp end
    if left.kind_rank ~= right.kind_rank then return left.kind_rank < right.kind_rank end
    return left.order < right.order
  end)
  for _, entry in ipairs(activity) do table.insert(entries, entry) end
  local parts = {}
  for index, entry in ipairs(entries) do
    if index == 1 then table.insert(parts, entry.text)
    else table.insert(parts, '—— ' .. entry.kind .. ' · ' .. entry.author .. ' · ' .. entry.timestamp .. ' ——\n' .. entry.text) end
  end
  local body = table.concat(parts, '\n\n')
  return comment.resolved and ('Resolved\n\n' .. body) or body
end

-- 31-bit FNV-1a over the UTF-8 bytes of the local ID, a NUL separator, and
-- the exact flattened transcript sent to Word. This provenance snapshot keeps
-- a later local edit from being mistaken for the exported Word comment.
local function word_id(local_id, exported_body)
  local hash = 0x811c9dc5
  local input = local_id .. '\0' .. exported_body
  for index = 1, #input do
    hash = (hash ~ string.byte(input, index)) * 0x01000193
    hash = hash & 0xffffffff
  end
  hash = hash & 0x7fffffff
  if hash == 0 then hash = 1 end
  return tostring(hash)
end

local function literal_inlines(text)
  -- Pandoc's native line-break inline represents all source newline styles.
  -- Normalise before splitting so CRLF never becomes Space + LineBreak.
  text = text:gsub('\r\n', '\n'):gsub('\r', '\n')
  local result = {}
  local first = true
  for line in (text .. '\n'):gmatch('(.-)\n') do
    if not first then table.insert(result, pandoc.LineBreak()) end
    first = false
    local word_start = 1
    while word_start <= #line do
      local space_start, space_end = line:find('%s+', word_start)
      if space_start == word_start then
        table.insert(result, pandoc.Space())
        word_start = space_end + 1
      else
        local finish = space_start and space_start - 1 or #line
        if finish >= word_start then table.insert(result, pandoc.Str(line:sub(word_start, finish))) end
        word_start = space_start or (#line + 1)
      end
    end
  end
  return result
end

local function inline_text(inlines)
  local result = {}
  for _, inline in ipairs(inlines) do
    if inline.t == 'Str' then table.insert(result, inline.text)
    elseif inline.t == 'Space' then table.insert(result, ' ')
    elseif inline.t == 'SoftBreak' or inline.t == 'LineBreak' then table.insert(result, '\n')
    else return nil end
  end
  return table.concat(result)
end

-- This broader text view is used only to count candidate occurrences. Rewriting
-- remains deliberately limited to inline_text's simple, top-level structures.
local function rendered_inline_text(inlines)
  local ok, text = pcall(pandoc.utils.stringify, inlines)
  return ok and text or nil
end

local function rendered_block_texts(doc)
  local result = {}
  -- Pandoc's native walk visits blocks inside all containers, including table
  -- cells and structures added by newer Pandoc versions. This is counting only:
  -- the separate rewrite pass remains limited to top-level simple blocks.
  doc:walk({
    Para = function(block)
      local text = rendered_inline_text(block.content)
      if text then table.insert(result, text) end
    end,
    Plain = function(block)
      local text = rendered_inline_text(block.content)
      if text then table.insert(result, text) end
    end,
    Header = function(block)
      local text = rendered_inline_text(block.content)
      if text then table.insert(result, text) end
    end,
  })
  return result
end

local function rewrite_block(block, candidates, used)
  if block.t ~= 'Para' and block.t ~= 'Plain' and block.t ~= 'Header' then return block end
  local inlines = block.t == 'Header' and block.content or block.content
  local text = inline_text(inlines)
  if not text then return block end
  local matches = {}
  for _, candidate in ipairs(candidates) do
    local from = 1
    while true do
      local start = text:find(candidate.selection, from, true)
      if not start then break end
      table.insert(matches, {start = start, finish = start + #candidate.selection - 1, candidate = candidate})
      -- Advance one byte so overlapping literal occurrences (for example
      -- `aaa` in `aaaa`) make the source ambiguous instead of exportable.
      from = start + 1
    end
  end
  if #matches == 0 then return block end
  -- A selection must have one and only one rendered occurrence in the document.
  local accepted = {}
  for _, match in ipairs(matches) do
    if candidates[match.candidate.index].occurrences == 1 then table.insert(accepted, match) end
  end
  table.sort(accepted, function(left, right) return left.start < right.start end)
  for index = 2, #accepted do
    if accepted[index].start <= accepted[index - 1].finish then
      accepted[index].candidate.overlap = true
      accepted[index - 1].candidate.overlap = true
    end
  end
  if #accepted == 0 then return block end
  local starts, ends = {}, {}
  for _, match in ipairs(accepted) do
    if not match.candidate.overlap then
      starts[match.start] = match.candidate
      ends[match.finish + 1] = match.candidate
      used[match.candidate.index] = true
    end
  end
  local function start_marker(candidate)
    local attr = pandoc.Attr('', {'comment-start'}, {
      id = candidate.word_id, author = candidate.comment.author, date = candidate.comment.timestamp
    })
    return pandoc.Span(literal_inlines(candidate.body), attr)
  end
  local function end_marker(candidate)
    return pandoc.Span({}, pandoc.Attr('', {'comment-end'}, {id = candidate.word_id}))
  end
  -- Split only ordinary top-level text inlines. Everything else was rejected by
  -- inline_text above, so surrounding content and formatting are retained.
  local output, position = {}, 1
  local emitted = {}
  local function markers_at(offset)
    if emitted[offset] then return end
    if ends[offset] then table.insert(output, end_marker(ends[offset])) end
    if starts[offset] then table.insert(output, start_marker(starts[offset])) end
    emitted[offset] = true
  end
  for _, inline in ipairs(inlines) do
    local piece = inline.t == 'Str' and inline.text
      or inline.t == 'Space' and ' '
      or (inline.t == 'SoftBreak' or inline.t == 'LineBreak') and '\n' or nil
    if not piece then return block end
    local finish = position + #piece
    markers_at(position)
    if inline.t == 'Str' then
      local cursor = position
      local boundaries = {}
      local seen = {}
      for offset, _ in pairs(starts) do
        if offset > position and offset < finish then seen[offset] = true end
      end
      for offset, _ in pairs(ends) do
        if offset > position and offset < finish then seen[offset] = true end
      end
      for offset, _ in pairs(seen) do table.insert(boundaries, offset) end
      table.sort(boundaries)
      for _, boundary in ipairs(boundaries) do
        if boundary > cursor then table.insert(output, pandoc.Str(piece:sub(cursor - position + 1, boundary - position))) end
        markers_at(boundary)
        cursor = boundary
      end
      if cursor < finish then table.insert(output, pandoc.Str(piece:sub(cursor - position + 1))) end
    else
      table.insert(output, inline)
    end
    markers_at(finish)
    position = finish
  end
  block.content = output
  return block
end

local function add_docx_comments(doc, input, workspace, show_resolved)
  local lines, read_error = source_lines(input)
  if not lines then
    io.stderr:write('[collab-comments] skipped Word export: ' .. read_error .. '\n')
    return doc
  end
  local selected = exported_comments(workspace, input, show_resolved)
  local raw_candidates = {}
  for _, comment in ipairs(selected) do
    local literal, reason = selected_source_text(lines, comment)
    if not literal then warning(input, comment, reason)
    else
      local body = transcript(comment)
      table.insert(raw_candidates, {comment = comment, selection = literal, body = body,
        word_id = word_id(comment.id, body), occurrences = 0})
    end
  end
  local id_counts = {}
  for _, candidate in ipairs(raw_candidates) do id_counts[candidate.word_id] = (id_counts[candidate.word_id] or 0) + 1 end
  local candidates = {}
  for _, candidate in ipairs(raw_candidates) do
    if id_counts[candidate.word_id] > 1 then warning(input, candidate.comment, 'deterministic Word ID collision')
    else
      candidate.index = #candidates + 1
      table.insert(candidates, candidate)
    end
  end
  -- Count every rendered Para/Plain/Header before rewriting, including content
  -- in nested containers and tables. A match in an unsupported rewrite
  -- structure still makes another match ambiguous.
  local rendered_blocks = rendered_block_texts(doc)
  for _, text in ipairs(rendered_blocks) do
    for _, candidate in ipairs(candidates) do
      local from = 1
      while true do
        local start = text:find(candidate.selection, from, true)
        if not start then break end
        candidate.occurrences = candidate.occurrences + 1
        -- Count overlapping rendered occurrences too; this must agree with
        -- rewrite_block's literal scan above.
        from = start + 1
      end
    end
  end
  local used = {}
  local blocks = {}
  for _, block in ipairs(doc.blocks) do table.insert(blocks, rewrite_block(block, candidates, used)) end
  doc.blocks = blocks
  for _, candidate in ipairs(candidates) do
    if candidate.overlap then warning(input, candidate.comment, 'overlapping rendered selection')
    elseif candidate.occurrences == 0 then warning(input, candidate.comment, 'selection is absent from supported rendered blocks')
    elseif candidate.occurrences > 1 then warning(input, candidate.comment, 'selection is ambiguous in rendered document')
    elseif not used[candidate.index] then warning(input, candidate.comment, 'selection occurs only in unsupported rendered structure')
    end
  end
  return doc
end

function Pandoc(doc)
  local input = current_input()
  local workspace = normalize(quarto.project.directory or pandoc.system.get_working_directory())
  local export = config_value(doc.meta, 'export', false)
  local docx_comments = config_value(doc.meta, 'docx-comments', false)
  local show_resolved = config_value(doc.meta, 'show-resolved', false)
  if quarto.doc.is_format('docx') then
    return docx_comments and add_docx_comments(doc, input, workspace, show_resolved) or doc
  end
  if not quarto.doc.is_format('html') or quarto.doc.is_format('revealjs') or quarto.doc.is_format('dashboard') then return doc end
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
