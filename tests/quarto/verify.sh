#!/usr/bin/env bash
set -euo pipefail

check_root=$(mktemp -d "${TMPDIR:-/tmp}/collab-comments-quarto.XXXXXX")
trap 'rm -rf "$check_root"' EXIT
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
