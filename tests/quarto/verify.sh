#!/usr/bin/env bash
set -euo pipefail

check_root=$(mktemp -d "${TMPDIR:-/tmp}/collab-comments-quarto.XXXXXX")
trap 'rm -rf "$check_root"' EXIT

assert_docx_marker_counts() {
  local marker_id="$1"
  local marker
  for marker in 'w:commentRangeStart' 'w:commentRangeEnd' 'w:commentReference'; do
    test "$(rg -oF "$marker w:id=\"$marker_id\"" "$check_root/word-document.xml" | wc -l | tr -d ' ')" -eq 1
  done
}

assert_roundtrip_pairs() {
  node - "$check_root/word-roundtrip.json" "$@" <<'NODE'
const fs = require('fs');
const [file, ...expected] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(file, 'utf8'));
const starts = new Map(expected.map(id => [id, 0]));
const ends = new Map(expected.map(id => [id, 0]));
const stack = [document];
while (stack.length) {
  const value = stack.pop();
  if (Array.isArray(value)) {
    stack.push(...value);
    continue;
  }
  if (!value || typeof value !== 'object') continue;
  if (value.t === 'Span' && Array.isArray(value.c) && Array.isArray(value.c[0])) {
    const [, classes, values] = value.c[0];
    const id = Array.isArray(values) ? values.find(item => Array.isArray(item) && item[0] === 'id')?.[1] : undefined;
    if (typeof id === 'string' && Array.isArray(classes)) {
      if (classes.includes('comment-start') && starts.has(id)) starts.set(id, starts.get(id) + 1);
      if (classes.includes('comment-end') && ends.has(id)) ends.set(id, ends.get(id) + 1);
    }
  }
  stack.push(...Object.values(value));
}
for (const id of expected) {
  if (starts.get(id) !== 1 || ends.get(id) !== 1) {
    throw new Error(`expected exactly one comment-start/end pair for ${id}; got ${starts.get(id)}/${ends.get(id)}`);
  }
}
NODE
}

mkdir -p "$check_root/_extensions" "$check_root/.comments"
cp -R "$(pwd)/_extensions/collab-comments" "$check_root/_extensions/"
cat > "$check_root/document.qmd" <<'EOF'
---
title: Preview fixture
filters: [collab-comments]
collab-comments:
  export: false
---

This literal selection is safe.
EOF
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"safe-id","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"</script><script>window.evil=true</script>","filePath":"document.qmd","range":{"start":{"line":7,"character":0},"end":{"line":7,"character":4}},"selectedText":"This","contextBefore":"","contextAfter":" literal"}]}
EOF

(cd "$check_root" && quarto render document.qmd --to html)
! rg -q 'window.evil=true|collab-comments-config' "$check_root/document.html"

mkdir -p "$check_root/tmp/collab-comments-preview"
cat > "$check_root/tmp/collab-comments-preview/collab-comments-preview-probe.json" <<EOF
{"schemaVersion":1,"workspace":"$check_root","endpoint":"http://127.0.0.1:45678","token":"$(printf 'x%.0s' {1..43})","expiresAt":"2999-01-01T00:00:00Z"}
EOF
(cd "$check_root" && TMPDIR="$check_root/tmp" quarto render document.qmd --to html)
! rg -q 'collab-comments-config|127.0.0.1:45678' "$check_root/document.html"

chmod 700 "$check_root/tmp/collab-comments-preview"
cat > "$check_root/tmp/collab-comments-preview/collab-comments-preview-probe.json" <<EOF
{"schemaVersion":1,"workspace":"$check_root","endpoint":"http://localhost:45678","token":"$(printf 'x%.0s' {1..43})","expiresAt":"2999-01-01T00:00:00Z"}
EOF
(cd "$check_root" && TMPDIR="$check_root/tmp" quarto render document.qmd --to html)
! rg -q 'collab-comments-config|localhost:45678' "$check_root/document.html"

cat > "$check_root/tmp/collab-comments-preview/collab-comments-preview-probe.json" <<EOF
{"schemaVersion":1,"workspace":"$check_root","endpoint":"http://127.0.0.1:45678","token":"$(printf 's%.0s' {1..43})","expiresAt":"2999-01-01T00:00:00Z","heartbeatAt":"2026-01-01T00:00:00Z"}
EOF
(cd "$check_root" && TMPDIR="$check_root/tmp" quarto render document.qmd --to html)
rg -Fq 'http://127.0.0.1:45678' "$check_root/document.html"
! rg -Fq "$(printf 's%.0s' {1..43})" "$check_root/document.html"
! rg -Fq "$check_root/document.qmd" "$check_root/document.html"
! rg -Fq 'window.evil=true' "$check_root/document.html"

sed -i.bak 's/export: false/export: true/' "$check_root/document.qmd"
(cd "$check_root" && TMPDIR="$check_root/tmp" quarto render document.qmd --to html)
rg -q 'collab-comments-config' "$check_root/document.html"
rg -Fq 'window.evil=true' "$check_root/document.html"
rg -Fq '"author":"Tester"' "$check_root/document.html"
rg -Fq 'document.qmd' "$check_root/document.html"
rg -Fq '\u003c/script\u003e' "$check_root/document.html"
! rg -Fq 'http://127.0.0.1:45678' "$check_root/document.html"
! rg -q '<script>window.evil=true</script>' "$check_root/document.html"

cat > "$check_root/reveal.qmd" <<'EOF'
---
title: Reveal fixture
filters: [collab-comments]
format: revealjs
---

Slide text.
EOF
(cd "$check_root" && quarto render reveal.qmd)
! rg -q 'collab-comments-config' "$check_root/reveal.html"
cat > "$check_root/dashboard.qmd" <<'EOF'
---
title: Dashboard fixture
filters: [collab-comments]
format: dashboard
---

Dashboard text.
EOF
(cd "$check_root" && quarto render dashboard.qmd)
! rg -q 'collab-comments-config' "$check_root/dashboard.html"
(cd "$check_root" && quarto render document.qmd --to docx)
test -f "$check_root/document.docx"
! unzip -l "$check_root/document.docx" | rg -q 'word/comments.xml'

# DOCX comments are a separate explicit opt-in. Verify the native Word parts,
# deterministic range IDs, literal hostile text, Unicode, and resolved filtering.
cat > "$check_root/document.qmd" <<'EOF'
---
title: Word comment fixture
filters: [collab-comments]
collab-comments:
  export: false
  docx-comments: true
  show-resolved: false
---

This literal selection is safe.

Astral 😀 selection.

Ordering selection.

Legacy timestamp selection.
EOF
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"safe-id","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"</script><script>window.evil=true</script> café Body  with\ttabs\r\nCRLF second","filePath":"document.qmd","range":{"start":{"line":9,"character":0},"end":{"line":9,"character":4}},"selectedText":"This","replies":[],"trackedChanges":[],"resolved":false},{"id":"é","author":"Unicode Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"Unicode body","filePath":"document.qmd","range":{"start":{"line":11,"character":7},"end":{"line":11,"character":9}},"selectedText":"😀","replies":[],"trackedChanges":[],"resolved":false},{"id":"ordering-id","author":"Ordering tester","timestamp":"2026-01-03T00:00:00.000Z","text":"Opening order","filePath":"document.qmd","range":{"start":{"line":13,"character":0},"end":{"line":13,"character":8}},"selectedText":"Ordering","replies":[{"id":"reply-first","author":"First responder","timestamp":"2026-01-02T00:00:00.000Z","text":"First reply"},{"id":"reply-second","author":"Second responder","timestamp":"2026-01-02T00:00:00.000Z","text":"Second reply"}],"trackedChanges":[{"id":"change-first","author":"Editor A","timestamp":"2026-01-02T00:00:00.000Z","previousText":"one","newText":"two"},{"id":"change-second","author":"Editor B","timestamp":"2026-01-02T00:00:00.000Z","previousText":"three","newText":"four"}],"resolved":false},{"id":"legacy-timestamp-id","author":"Legacy timestamp tester","timestamp":"opening-not-sorted","text":"Legacy opening","filePath":"document.qmd","range":{"start":{"line":15,"character":0},"end":{"line":15,"character":6}},"selectedText":"Legacy","replies":[{"id":"late","author":"Later responder","timestamp":"z-legacy","text":"Later by ordinal"},{"id":"early","author":"Earlier responder","timestamp":"A-legacy","text":"Earlier by ordinal"}],"trackedChanges":[],"resolved":false},{"id":"legacy-id","author":"Legacy reviewer","timestamp":"2026-01-01T00:00:00.000Z","text":"Must not range export","filePath":"document.qmd","range":{"start":{"line":9,"character":5},"end":{"line":9,"character":12}},"replies":[],"trackedChanges":[],"resolved":false},{"id":"resolved-id","author":"Resolved reviewer","timestamp":"2026-01-01T00:00:00.000Z","text":"Do not export yet","filePath":"document.qmd","range":{"start":{"line":9,"character":5},"end":{"line":9,"character":12}},"selectedText":"literal","replies":[],"trackedChanges":[],"resolved":true}]}
EOF
cp "$check_root/.comments/collab-comments.json" "$check_root/document-comments.json"
(cd "$check_root" && quarto render document.qmd --to docx)
unzip -l "$check_root/document.docx" | rg -q 'word/comments.xml'
unzip -p "$check_root/document.docx" word/comments.xml > "$check_root/comments.xml"
unzip -p "$check_root/document.docx" word/document.xml > "$check_root/word-document.xml"
rg -Fq 'Tester' "$check_root/comments.xml"
rg -Fq 'Unicode Tester' "$check_root/comments.xml"
rg -Fq 'Unicode body' "$check_root/comments.xml"
rg -Fq 'window.evil=true' "$check_root/comments.xml"
rg -Fq 'café' "$check_root/comments.xml"
! rg -Fq 'Resolved reviewer' "$check_root/comments.xml"
! rg -Fq 'Legacy reviewer' "$check_root/comments.xml"
rg -Fq 'w:commentRangeStart w:id="1481058377"' "$check_root/word-document.xml"
rg -Fq 'w:commentRangeStart w:id="965176182"' "$check_root/word-document.xml"
rg -Fq 'w:commentRangeStart w:id="1322354704"' "$check_root/word-document.xml"
rg -Fq 'w:commentRangeStart w:id="1709996011"' "$check_root/word-document.xml"
assert_docx_marker_counts 1481058377
assert_docx_marker_counts 965176182
assert_docx_marker_counts 1322354704
assert_docx_marker_counts 1709996011
! rg -Fq '127.0.0.1' "$check_root/comments.xml"
! rg -Fq 'collab-comments-preview' "$check_root/comments.xml"
! rg -Fq 'token' "$check_root/comments.xml"
(cd "$check_root" && quarto pandoc document.docx --track-changes=all --to=json > word-roundtrip.json)
rg -Fq 'comment-start' "$check_root/word-roundtrip.json"
rg -Fq 'window.evil=true' "$check_root/word-roundtrip.json"
assert_roundtrip_pairs 1481058377 965176182 1322354704 1709996011
node - "$check_root/word-roundtrip.json" <<'NODE'
const fs = require('fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let body;
function inlineText(inlines) {
  return inlines.map(inline => inline.t === 'Str' ? inline.c
    : inline.t === 'Space' ? ' '
      : inline.t === 'SoftBreak' || inline.t === 'LineBreak' ? '\n' : '').join('');
}
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.t === 'Span' && Array.isArray(value.c)) {
    const [attr, content] = value.c;
    const classes = Array.isArray(attr) && Array.isArray(attr[1]) ? attr[1] : [];
    const values = Array.isArray(attr) && Array.isArray(attr[2]) ? new Map(attr[2]) : new Map();
    if (classes.includes('comment-start') && values.get('id') === '1481058377') body = inlineText(content);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child);
}
walk(document);
const expected = '</script><script>window.evil=true</script> café Body with tabs\nCRLF second';
if (body !== expected) throw new Error(`CRLF Word transcript mismatch: ${JSON.stringify(body)}`);
NODE
node - "$check_root/comments.xml" <<'NODE'
const fs = require('fs');
const xml = fs.readFileSync(process.argv[2], 'utf8');
const text = xml.replace(/<[^>]*>/g, '');
for (const [left, right] of [
  ['Opening order', 'First reply'],
  ['First reply', 'Second reply'],
  ['Second reply', 'Previous: one'],
  ['Previous: one', 'Previous: three'],
  ['Earlier by ordinal', 'Later by ordinal'],
]) {
  if (text.indexOf(left) === -1 || text.indexOf(left) >= text.indexOf(right)) {
    throw new Error(`expected transcript ordering ${left} before ${right}`);
  }
}
NODE

# Rendered occurrences in list/formatting structures count toward ambiguity even
# though the conservative writer cannot safely rewrite those structures. A unique
# unsupported list selection is also skipped rather than guessed.
cat > "$check_root/unsupported.qmd" <<'EOF'
---
title: Unsupported Word comment fixture
filters: [collab-comments]
collab-comments:
  docx-comments: true
---

- duplicated list phrase

duplicated list phrase

- unique list phrase

**formatted duplicated phrase**

formatted duplicated phrase
EOF
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"list-duplicate","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"List duplicate","filePath":"unsupported.qmd","range":{"start":{"line":7,"character":2},"end":{"line":7,"character":24}},"selectedText":"duplicated list phrase","replies":[],"trackedChanges":[],"resolved":false},{"id":"list-unique","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"List unique","filePath":"unsupported.qmd","range":{"start":{"line":11,"character":2},"end":{"line":11,"character":20}},"selectedText":"unique list phrase","replies":[],"trackedChanges":[],"resolved":false},{"id":"formatted-duplicate","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"Formatted duplicate","filePath":"unsupported.qmd","range":{"start":{"line":13,"character":2},"end":{"line":13,"character":29}},"selectedText":"formatted duplicated phrase","replies":[],"trackedChanges":[],"resolved":false}]}
EOF
(cd "$check_root" && quarto render unsupported.qmd --to docx)
test -f "$check_root/unsupported.docx"
! unzip -l "$check_root/unsupported.docx" | rg -q 'word/comments.xml'

# Overlapping literal occurrences must make the rendered selection ambiguous.
# `aaa` occurs twice in `aaaa`, at byte offsets one and two.
cat > "$check_root/overlapping.qmd" <<'EOF'
---
title: Overlapping Word comment fixture
filters: [collab-comments]
collab-comments:
  docx-comments: true
---

aaaa
EOF
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"overlap-id","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"Overlapping selection","filePath":"overlapping.qmd","range":{"start":{"line":7,"character":0},"end":{"line":7,"character":3}},"selectedText":"aaa","replies":[],"trackedChanges":[],"resolved":false}]}
EOF
(cd "$check_root" && quarto render overlapping.qmd --to docx) 2> "$check_root/overlapping.err"
test -f "$check_root/overlapping.docx"
! unzip -l "$check_root/overlapping.docx" | rg -q 'word/comments.xml'
rg -Fq 'skipped Word comment overlap-id: selection is ambiguous in rendered document' "$check_root/overlapping.err"

# Text in table cells is counted too. The selected table occurrence and a plain
# paragraph occurrence are ambiguous, so neither can be re-anchored in Word.
cat > "$check_root/table-ambiguity.qmd" <<'EOF'
---
title: Table ambiguity fixture
filters: [collab-comments]
collab-comments:
  docx-comments: true
---

| Column |
|---|
| table cell phrase |

table cell phrase
EOF
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"table-cell-duplicate","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"Table duplicate","filePath":"table-ambiguity.qmd","range":{"start":{"line":9,"character":2},"end":{"line":9,"character":19}},"selectedText":"table cell phrase","replies":[],"trackedChanges":[],"resolved":false}]}
EOF
(cd "$check_root" && quarto render table-ambiguity.qmd --to docx) 2> "$check_root/table-ambiguity.err"
test -f "$check_root/table-ambiguity.docx"
! unzip -l "$check_root/table-ambiguity.docx" | rg -q 'word/comments.xml'
rg -Fq 'skipped Word comment table-cell-duplicate: selection is ambiguous in rendered document' "$check_root/table-ambiguity.err"

cp "$check_root/document-comments.json" "$check_root/.comments/collab-comments.json"
sed -i.bak 's/show-resolved: false/show-resolved: true/' "$check_root/document.qmd"
(cd "$check_root" && quarto render document.qmd --to docx)
unzip -p "$check_root/document.docx" word/comments.xml > "$check_root/comments-with-resolved.xml"
rg -Fq 'Resolved reviewer' "$check_root/comments-with-resolved.xml"
# The remaining legacy static-export checks deliberately use export=true.
sed -i.bak 's/export: false/export: true/' "$check_root/document.qmd"

# The filter must reject oversized untrusted reads before JSON decoding or
# source-line extraction, while keeping the ordinary static HTML shell intact.
cat > "$check_root/oversized-store.qmd" <<'EOF'
---
title: Oversized store fixture
filters: [collab-comments]
collab-comments:
  export: true
---

No exported comments.
EOF
node - "$check_root/.comments/collab-comments.json" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], '{"comments":[');
fs.truncateSync(process.argv[2], 20 * 1024 * 1024 + 1);
NODE
(cd "$check_root" && quarto render oversized-store.qmd --to html) 2> "$check_root/oversized-store.err"
rg -q 'collab-comments-config' "$check_root/oversized-store.html"
rg -Fq 'comment store exceeds 20 MiB limit' "$check_root/oversized-store.err"

cat > "$check_root/oversized-source.qmd" <<'EOF'
---
title: Oversized source fixture
filters: [collab-comments]
collab-comments:
  docx-comments: true
---

Bounded selection.
<!--
EOF
node - "$check_root/oversized-source.qmd" <<'NODE'
const fs = require('fs');
fs.appendFileSync(process.argv[2], 'x'.repeat(20 * 1024 * 1024));
fs.appendFileSync(process.argv[2], '-->\n');
NODE
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"oversized-source-id","author":"Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"Must not export","filePath":"oversized-source.qmd","range":{"start":{"line":7,"character":0},"end":{"line":7,"character":7}},"selectedText":"Bounded","replies":[],"trackedChanges":[],"resolved":false}]}
EOF
(cd "$check_root" && quarto render oversized-source.qmd --to docx) 2> "$check_root/oversized-source.err"
test -f "$check_root/oversized-source.docx"
! unzip -l "$check_root/oversized-source.docx" | rg -q 'word/comments.xml'
rg -Fq 'QMD source exceeds 20 MiB limit' "$check_root/oversized-source.err"

# Missing and malformed stores are inert, rather than breaking static export.
mkdir -p "$check_root/missing-store/_extensions"
cp -R "$check_root/_extensions/collab-comments" "$check_root/missing-store/_extensions/"
cat > "$check_root/missing-store/document.qmd" <<'EOF'
---
title: Missing store fixture
filters: [collab-comments]
collab-comments:
  export: true
---

No local store.
EOF
(cd "$check_root/missing-store" && quarto render document.qmd --to html)
rg -q 'collab-comments-config' "$check_root/missing-store/document.html"
printf '42\n' > "$check_root/.comments/collab-comments.json"
(cd "$check_root" && quarto render document.qmd --to html)
rg -q 'collab-comments-config' "$check_root/document.html"
! rg -Fq '"comments":[42]' "$check_root/document.html"
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":["bad",{"filePath":"document.qmd","bogus":"MALFORMED-STATIC-COMMENT"}]}
EOF
(cd "$check_root" && quarto render document.qmd --to html)
rg -q 'collab-comments-config' "$check_root/document.html"
! rg -Fq '"bad"' "$check_root/document.html"
! rg -Fq 'MALFORMED-STATIC-COMMENT' "$check_root/document.html"

mkdir -p "$check_root/nested-project/_extensions"
cp -R "$check_root/_extensions/collab-comments" "$check_root/nested-project/_extensions/"
cat > "$check_root/nested-project/_quarto.yml" <<'EOF'
project:
  type: default
EOF
cat > "$check_root/nested-project/document.qmd" <<'EOF'
---
title: Nested fixture
filters: [collab-comments]
collab-comments:
  export: true
---

Nested selection.
EOF
cat > "$check_root/.comments/collab-comments.json" <<'EOF'
{"comments":[{"id":"nested id","author":"Nested Tester","timestamp":"2026-01-01T00:00:00.000Z","text":"Nested export text","filePath":"nested-project/document.qmd","range":{"start":{"line":7,"character":0},"end":{"line":7,"character":6}},"selectedText":"Nested","contextBefore":"","contextAfter":" selection"}]}
EOF
(cd "$check_root/nested-project" && quarto render document.qmd --to html)
rg -Fq 'Nested export text' "$check_root/nested-project/document.html"
