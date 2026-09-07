# Word comment round-trip implementation plan

Status: implemented (conservative top-level/flattened Word workflow)  
Last updated: 29 August 2026

## Purpose

Add an opt-in workflow that:

1. renders comments from `.comments/collab-comments.json` as native Microsoft Word
   comments in Quarto DOCX output; and
2. imports comments from a reviewed DOCX back into the comment store so they appear
   in the VS Code extension and Quarto preview.

The QMD source remains unchanged during both operations. The comment store continues
to be the authoritative collaboration record.

## Confirmed technical basis

Pandoc's DOCX writer converts paired `comment-start` and `comment-end` spans into
native Word comments. Its DOCX reader exposes those comments again when invoked with
`--track-changes=all`. A local round-trip with the Pandoc 3.10 bundled in Quarto
1.10.18 preserved:

- the Word comment ID;
- author;
- timestamp;
- comment body; and
- the start and end of the commented document text.

This lets the Quarto Lua filter implement export without directly modifying the DOCX
ZIP/XML package. Import can call the bundled Pandoc reader and consume its JSON AST.

## Goals

- Keep DOCX comment export disabled by default.
- Produce ordinary Word comments anchored to rendered document text.
- Import new Word comments as extension comment threads.
- Recognise comments that originated in the extension and avoid duplicating them.
- Preserve author and timestamp where Word supplies valid values.
- Reuse conservative QMD selection mapping and reject ambiguous matches.
- Make imports previewable, additive, cancellable, and conflict-aware.
- Handle all DOCX and Pandoc data as untrusted input.
- Keep static HTML export behaviour and preview-bridge security unchanged.

## Non-goals

- Do not insert comment syntax, callouts, or HTML comments into QMD source.
- Do not automatically import a DOCX merely because it was rendered or opened.
- Do not infer that deleting a Word comment means deleting a local thread.
- Do not overwrite existing local comment or reply text from a Word document.
- Do not synchronise Word document edits or tracked changes into QMD.
- Do not guess when rendered text maps to multiple source locations.
- Do not require Microsoft Word to perform export or import.
- Do not hand-edit OOXML unless later testing proves that native Word replies or
  resolved state justify a narrowly scoped reader.

## User-facing contract

### Export configuration

Use a separate opt-in from static HTML export:

```yaml
filters: [collab-comments]

collab-comments:
  export: false
  docx-comments: true
  show-resolved: false
```

- `export` retains its current meaning for static HTML.
- `docx-comments` controls native comments in DOCX output and defaults to `false`.
- `show-resolved` controls whether resolved threads are included in either opted-in
  export mode.
- The filter remains inert for other output formats.

Keeping the flags separate prevents enabling Word review output from unexpectedly
publishing comment text in static HTML.

### Import command

Add the command:

```text
Collab Comments: Import Comments from Word…
```

Initial workflow:

1. Open and save the target QMD in the first workspace folder.
2. Run the import command.
3. Select a `.docx` file.
4. Review a summary of importable, already-present, ambiguous, unsupported, and
   malformed comments.
5. Confirm the import.
6. Apply all accepted additions in one conflict-aware repository write.

The reviewed DOCX may be outside the workspace because selecting it explicitly grants
read access. The target QMD must be a saved file inside the supported workspace.

## Core invariants

1. **No silent mis-anchoring.** Import and export skip an ambiguous selection rather
   than attach it to the wrong passage.
2. **No implicit source edits.** DOCX operations never modify QMD text.
3. **No destructive import.** Import may create threads or append replies, but it does
   not delete, resolve, unresolve, or overwrite local content.
4. **No stale writes.** The normal repository revision/conflict checks apply to the
   entire import transaction.
5. **No partial imports.** Validation and user confirmation happen before the store is
   mutated; accepted changes are written together.
6. **No executable comment content.** Word text is imported as plain text and exported
   as literal Pandoc inlines, never parsed as Markdown or raw markup.
7. **No DOCX leakage by default.** `docx-comments` must be explicitly enabled.

## Proposed architecture

### Quarto export path

Extend `_extensions/collab-comments/collab-comments.lua` to branch by output format:

```text
validated comment store
        |
        +-- HTML + export=true ------> existing static HTML snapshot
        |
        +-- DOCX + docx-comments=true
                    |
                    +-- conservative rendered-text anchoring
                    +-- Pandoc comment-start/comment-end spans
                    +-- native Word comments from the DOCX writer
```

Reuse the current store discovery, path normalisation, schema validation, and resolved
filtering. Do not expose the preview bridge or its capability token to DOCX output.

Pandoc expects a structure equivalent to:

```markdown
[Comment body]{.comment-start id="7" author="Alice" date="2026-08-29T01:02:03Z"}
selected text[]{.comment-end id="7"}
```

The filter should construct Pandoc AST elements directly rather than generate and
reparse Markdown.

### VS Code import path

Add a pure TypeScript module, tentatively `src/wordComments.ts`, for Word/Pandoc
domain logic. Keep process execution and VS Code UI orchestration in focused host code
or `src/extension.ts` initially.

```text
selected DOCX
    |
    +-- quarto pandoc --track-changes=all --to=json
    |
validated Pandoc JSON AST
    |
paired comment boundaries + rendered selection/context
    |
mapRenderedSelection(saved QMD, selection)
    |
classify: new / unchanged / changed / ambiguous / invalid
    |
user confirmation
    |
single conflict-aware CommentRepository write
```

Invoke the executable without a shell, using an argument array. Capture stdout with a
strict size limit, collect stderr for diagnostics, support cancellation, and report a
clear error if Quarto/Pandoc is unavailable.

### Suggested pure types

Exact names may change during implementation, but the import boundary should resemble:

```ts
interface WordComment {
  wordId: string;
  author: string;
  timestamp?: string;
  text: string;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
}

type WordImportCandidate =
  | { kind: 'new'; comment: CommentData }
  | { kind: 'unchanged'; wordComment: WordComment; existingId: string }
  | { kind: 'changed'; wordComment: WordComment; existingId: string }
  | { kind: 'ambiguous'; wordComment: WordComment; reason: string }
  | { kind: 'invalid'; wordId?: string; reason: string };
```

Pure functions should cover AST validation, boundary pairing, rendered-text
extraction, stable identity calculation, classification, and conversion to store
actions. This keeps most tests independent of VS Code and the actual Pandoc binary.

## Anchoring strategy

### Export anchoring

Comment ranges refer to raw QMD, while Pandoc operates on rendered document nodes.
The first implementation must therefore use a deliberately limited mapping:

1. Read the saved QMD source.
2. Verify that the stored range and `selectedText` still identify the expected source
   text, using stored context/re-anchoring where appropriate.
3. Build a plain-text view of each eligible Pandoc block while retaining enough node
   offsets to insert boundary spans.
4. Search for the literal selected text in rendered blocks.
5. Use rendered and stored context to distinguish candidates where possible.
6. Accept only a unique best match.
7. Split inline text nodes at the selected boundaries without changing their content
   or formatting.
8. Insert the comment-start marker immediately before the selection and the
   comment-end marker immediately after it.

Phase 1 rewrites only conservative top-level simple blocks: ordinary paragraphs,
plain blocks, and headings. It counts list and other structural selections when
checking for ambiguity, but skips and warns rather than rewriting them. It also skips
and warns for:

- selections spanning blocks;
- raw QMD markup that has no literal rendered equivalent;
- generated content;
- ambiguous repeated text;
- comments on content omitted from DOCX;
- unsupported inline structures; and
- overlapping ranges that cannot be represented safely.

Support for more inline containers can be expanded after fixtures prove that the AST
transformation preserves formatting.

### Import anchoring

1. Traverse the Pandoc AST in document order.
2. Treat the contents of a `comment-start` span as the comment body, not document
   text.
3. Pair start and end markers by Word comment ID.
4. Collect rendered text between the markers plus bounded before/after context.
5. Pass the selection to `mapRenderedSelection` against the saved QMD source.
6. Reject ties, missing literal text, overlong selections, malformed boundaries, and
   unsupported cross-structure ranges.

The existing mapper intentionally rejects tied candidates and should retain that
behaviour. Import must not weaken it merely to increase the success count.

### Formatting limitations

A Word selection such as `very important` may correspond to QMD source such as
`very **important**`, which is not a literal match. Phase 1 may skip this case. A later
enhancement can render the QMD to a parallel Pandoc AST and maintain a source-to-AST
mapping, but only after the simpler algorithm and its failure reporting are reliable.

## Thread and merge semantics

### Export representation

Phase 1 exports only the opening comment text as the Word comment body. Later phases
can append a readable transcript:

```text
Opening comment text

—— Reply · Bob · 29 Aug 2026, 11:42 ——
Reply text

—— Tracked change · Alice · 29 Aug 2026, 12:03 ——
Previous: old text
Current: new text
```

All fields are emitted as literal text. Delimiters are presentation only and are not
trusted as a machine-readable round-trip format.

### Import behaviour

- A genuinely new Word comment becomes a new `CommentData` thread.
- An exact copy of an exported comment is classified as unchanged and ignored.
- Changed content belonging to a known exported comment is appended as a new reply,
  labelled as imported from Word, rather than replacing the opening comment.
- A Word deletion has no local effect.
- Word's resolved state has no local effect unless a later, explicit and reviewed
  design adds support.
- Invalid Word timestamps fall back to the import time; original invalid strings are
  not persisted as authoritative dates.
- Missing authors use an explicit fallback such as `Word reviewer`, not the local
  default author silently.

### Word-native replies

Pandoc's portable comment representation is flat. Before promising native Word reply
support, test documents created by current Word versions on Windows and macOS.

- If Pandoc exposes reply text and relationships, map each new reply additively.
- If it flattens replies, import the changed combined body as one new extension reply.
- If it drops replies, report top-level-only support rather than silently claiming a
  complete round trip.
- Direct parsing of `commentsExtended.xml` or related modern-comment parts is a later
  decision gate, not part of the initial implementation.

## Stable identity and deduplication

Word comment IDs are numeric and normally survive a Pandoc round trip, whereas local
comment IDs are strings. Each export assigns a deterministic numeric Word ID derived
from the local ID and the exact exported transcript snapshot. Binding both values is
necessary to distinguish an untouched older export from activity deleted in Word
after a newer export.

Requirements for the mapping:

- deterministic across renders;
- valid for Pandoc and Word;
- collision detection within a document;
- no mutation of the comment store during a read-only render; and
- test vectors shared between Lua export and TypeScript import.

A small fixed algorithm such as a 31-bit FNV-1a hash is suitable if both
implementations use byte-identical UTF-8 input and collision handling is explicit.
Collisions must be reported and must not be used to update an existing thread.

An ID match alone is insufficient. Classifying a Word comment as an existing thread
should also validate available semantic evidence:

1. anchored selected text;
2. original author;
3. original timestamp; and
4. expected exported body or transcript.

Recommended match priority:

1. stable Word ID plus compatible semantic evidence;
2. exact author, timestamp, body, and anchored selection fingerprint;
3. otherwise treat it as new or conflicted and require user review.

Word may renumber comments after copying, merging, or using Save As. The semantic
fallback prevents renumbering from automatically creating duplicates, while the
preview keeps uncertain matches from mutating local threads.

Do not hide local IDs inside visible comment text or misuse author/initials fields.
Do not introduce OOXML post-processing solely to store identity unless real-world
testing shows that deterministic IDs are inadequate.

## Untrusted-input controls

Treat the DOCX, Pandoc JSON, comment store, QMD, and all metadata as untrusted.

- Use `spawn`/`execFile`, never a shell command assembled from file paths.
- Require a `.docx` selection and verify it is a regular readable file.
- Apply documented file-size, Pandoc-output-size, comment-count, body-length, and
  selection-length limits.
- Validate every JSON node before traversing it.
- Reject duplicate IDs, unmatched markers, invalid nesting, and impossible ranges.
- Convert comment content to plain strings and strip NUL characters.
- Never interpret imported comment text as Markdown, HTML, shell input, or a path.
- Require the target QMD to be saved, inside the first workspace folder, and not dirty.
- Refresh and validate repository state immediately before applying the import.
- Write through `CommentRepository`; do not write the JSON store directly.
- If Pandoc exits unsuccessfully, make no changes.
- Avoid logging full comment bodies in error telemetry or diagnostic output.

Limits should be named constants with tests. Choose final values during implementation
based on ordinary review documents rather than leaving subprocess buffers unbounded.

## Phase 0: contracts and test fixtures

Purpose: establish interoperable formats and failure behaviour before adding commands.

### Steps

1. Add a small generated DOCX round-trip fixture to the Quarto integration test:
   create Pandoc comment spans, render DOCX, then read it back with
   `--track-changes=all --to=json`.
2. Assert preservation of ID, author, timestamp, body, and selection boundaries.
3. Create fixtures for multiple comments, repeated selections, hostile text, Unicode,
   empty metadata, malformed markers, and comments crossing inline nodes.
4. Test current Word-created documents separately on Word for Windows and macOS if
   available; record what happens to native replies and resolved comments.
5. Finalise the `docx-comments` configuration name and default.
6. Finalise literal transcript formatting and author/timestamp fallbacks.
7. Define the pure TypeScript types and the Pandoc JSON subset accepted by the
   importer.
8. Define the stable numeric ID algorithm and publish shared test vectors in fixtures
   that Lua and TypeScript can both consume.
9. Decide and document concrete resource limits for DOCX size, AST output, comment
   count, selection length, and comment body length.
10. Confirm that unsupported comments produce visible warnings without failing the
    whole render or modifying any file.

### Acceptance criteria

- The verified Pandoc contract is represented by automated fixtures.
- Lua and TypeScript produce the same stable IDs for every test vector.
- Security limits and fallback semantics are written down and testable.
- No user-visible feature is enabled yet.

## Phase 1: native DOCX export and top-level import

Purpose: deliver a useful, conservative end-to-end workflow for top-level comments.

### A. Implement DOCX export

1. Refactor format selection in `collab-comments.lua` so HTML behaviour remains
   unchanged and DOCX has a separate branch.
2. Parse `collab-comments.docx-comments` as a boolean defaulting to `false`.
3. Reuse `exported_comments` validation and `show-resolved` filtering.
4. Read the saved QMD source and validate each stored anchor.
5. Implement a block-level rendered-text index for eligible Pandoc blocks.
6. Locate only unique exact selections and retain inline/node offsets.
7. Split affected inline text nodes at comment boundaries.
8. Insert literal `comment-start` and empty `comment-end` spans with unique numeric
   IDs, author, and timestamp.
9. Escape nothing by hand; construct Pandoc `Str`, `Space`, `SoftBreak`, and
   `LineBreak` nodes so hostile text remains text.
10. Skip unsupported, stale, overlapping, or ambiguous comments and emit a concise
    render warning with file, source line, and reason.
11. Ensure DOCX output contains no bridge endpoint, token, descriptor path, or other
    live-preview state.

### B. Add the pure import parser

1. Create `src/wordComments.ts`.
2. Validate the top-level Pandoc JSON document shape and the inline/block types the
   importer traverses.
3. Extract `comment-start` and `comment-end` spans and pair them by ID.
4. Reject duplicate, unmatched, invalidly nested, or empty selections.
5. Build the rendered selection and bounded before/after context.
6. Normalise Word line breaks without collapsing meaningful text.
7. Validate and normalise author, timestamp, body, and resource limits.
8. Map each extracted selection to the saved QMD with `mapRenderedSelection`.
9. Convert uniquely mapped Word comments to new `CommentData` values with fresh local
   IDs, empty reply/tracked-change arrays, and `resolved: false`.
10. Add an exact semantic fingerprint check so unchanged exported comments are skipped
    even before stable identity is complete.

### C. Add process and command orchestration

1. Register `comment-tracker.importCommentsFromWord` in `package.json` and activation
   code, using the displayed title above.
2. Require an active, saved `.qmd` in the first workspace folder.
3. Refuse import while the QMD is dirty.
4. Open a file picker restricted to DOCX files.
5. Verify file type, readability, and configured resource limits.
6. Locate `quarto` and invoke `quarto pandoc <file> --track-changes=all --to=json`
   without a shell.
7. Show cancellable progress while Pandoc runs.
8. Parse and classify all comments without mutating application state.
9. Present a confirmation summary with importable, unchanged, and skipped counts.
10. On confirmation, refresh the store revision and apply all new threads to a cloned
    store.
11. Save once through `CommentRepository`.
12. Refresh editor threads, decorations, tree view, discussion panel, and Quarto bridge
    state only after the write succeeds.
13. Display a completion message and place detailed skip reasons in a dedicated output
    channel.

### D. Tests and documentation

1. Add TypeScript unit tests beside `wordComments.ts` for valid extraction, adjacent
   comments, Unicode, line breaks, missing metadata, malformed AST, unmatched markers,
   nesting, limits, and exact deduplication.
2. Add tests for unique and ambiguous QMD mapping.
3. Add command/orchestration tests for cancellation, missing Quarto, Pandoc failure,
   dirty QMD, stale store, and declined confirmation where practical.
4. Extend `tests/quarto/verify.sh` to assert:
   - no Word comments by default;
   - native `word/comments.xml` when opted in;
   - correct author/body/range markers;
   - resolved filtering;
   - inert behaviour for malformed or missing stores;
   - safe hostile and Unicode text; and
   - no regression to existing HTML, revealjs, or dashboard behaviour.
5. Update README configuration, commands, limitations, security expectations, and
   import workflow.
6. Update the Quarto extension version if its distribution process requires it.

### Phase 1 acceptance criteria

- An opted-in Quarto DOCX contains native top-level Word comments.
- Default DOCX and HTML output remain unchanged.
- A new top-level Word comment on uniquely mappable literal text imports as one local
  thread.
- Reimporting an unchanged exported comment does not create a duplicate.
- Ambiguous, unsupported, malformed, cancelled, or conflicted imports make no unsafe
  changes.
- `npm test`, `npm run test:quarto`, and `npm run package` pass.
- Manual inspection succeeds in Microsoft Word for both unresolved and included
  resolved threads.

## Phase 2: stable identity and round-trip deduplication

Purpose: distinguish existing, changed, and new Word comments reliably across repeated
exports and imports.

### Steps

1. Enable the Phase 0 deterministic local-ID-and-snapshot-to-Word-ID mapping in Lua
   export.
2. Implement the identical algorithm in TypeScript and enforce the shared test
   vectors.
3. Detect numeric ID collisions during export; warn and skip or assign only a defined,
   deterministic collision fallback.
4. During import, calculate expected Word IDs for the current and reconstructable
   historical transcript snapshots of local threads relevant to the target QMD.
5. Match by stable ID only when selection, author, timestamp, and expected body are
   compatible.
6. Fall back to an exact semantic fingerprint when Word has renumbered comments.
7. Classify each extracted comment as:
   - new;
   - unchanged existing;
   - changed existing;
   - conflicting identity;
   - ambiguous anchor; or
   - invalid/unsupported.
8. For a changed existing comment, append a single reply containing the Word version
   and its author/time. Never overwrite the original comment or earlier replies.
9. Deduplicate repeated imports of the same changed Word version by reply fingerprint.
10. Treat a reused ID with incompatible evidence as a conflict requiring review, not
    an update.
11. Continue to ignore Word deletions and resolved state.
12. Include classification details in the import summary and output channel.
13. Add regression tests for rerendering, repeated import, Word ID renumbering, hash
    collision fixtures, changed text, changed author, copied comments, and concurrent
    local changes.

### Phase 2 acceptance criteria

- Exporting the same store repeatedly produces the same Word IDs.
- Export -> unchanged import is a no-op.
- Export -> edit Word comment -> import appends exactly one reply.
- Importing that same reviewed DOCX again is a no-op.
- A new Word comment becomes a new thread even when other exported comments are
  present.
- Identity conflicts never overwrite or silently attach to a local thread.
- All Phase 1 checks continue to pass.

## Phase 3: discussion transcripts, preview UI, and richer reconciliation

Purpose: make review of realistic threaded documents understandable and controllable.

### A. Export readable discussions

1. Add a pure transcript formatter with fixtures shared conceptually between Lua and
   TypeScript.
2. Export the opening comment followed by replies in timestamp order.
3. Include tracked-change entries in chronological order without representing them as
   Word tracked changes.
4. Clearly label author, timestamp, reply, tracked change, and resolved status.
5. Keep the transcript literal and readable when user text resembles a delimiter.
6. When `show-resolved: true`, include resolved threads with a visible status label.
7. Verify long and multiline discussions in Word, LibreOffice if supported, and a
   Pandoc round trip.

### B. Reconcile changed transcripts

1. Compare the incoming Word body with the transcript expected from current local
   state.
2. If equal, classify it as unchanged.
3. If different, calculate a display-only difference for user review.
4. Append the complete changed Word content as one imported reply unless a reliable
   native reply relationship is available. Timestamp that reply as an append-safe
   import event after existing activity; retain the Word timestamp on new threads.
5. Never attempt to reconstruct local replies by parsing human-editable transcript
   delimiters alone.
6. Deduplicate imported versions using a stable fingerprint that includes local thread
   ID, Word comment identity, author, timestamp, body, and anchored selection.

### C. Evaluate native Word replies and resolution

1. Create fixtures in current Word for Windows and Word for macOS containing:
   - replies by multiple authors;
   - resolved and reopened comments;
   - edited and deleted replies; and
   - comments copied between documents.
2. Inspect Pandoc JSON and OOXML parts to document what is retained.
3. If Pandoc exposes sufficient relationships, implement additive reply import in the
   pure parser.
4. If Pandoc loses them, keep documented flat/top-level semantics.
5. Consider a direct OOXML reader only through a separate design review covering ZIP
   limits, XML parser safety, Word version compatibility, dependency impact, and test
   fixtures.
6. Do not map Word resolution onto local resolution unless the import preview shows
   the action explicitly and the user selects it. This would relax the additive-only
   rule and therefore requires a separate decision.

### D. Add a detailed import preview

1. Present every candidate grouped by status: new, changed, unchanged, ambiguous,
   conflicting, and invalid.
2. Show author, Word comment text, selected text, proposed QMD line, and reason.
3. Preselect only safe new and changed candidates.
4. Let the user exclude individual candidates before import.
5. Do not allow ambiguous candidates until the user explicitly chooses a unique QMD
   anchor through a dedicated mapping interaction.
6. Revalidate QMD hash and store revision after preview and before save.
7. If either changed, cancel the transaction and require a fresh preview.
8. Keep webview content security policy intact if the existing discussion webview is
   reused; route messages through a separately validated protocol.
9. Ensure cancellation and closing the preview leave no state changes or temporary
   files.

### E. Improve diagnostics and usability

1. Add a dedicated `Collab Comments: Word Import` output channel.
2. Report actionable reasons without exposing full untrusted bodies.
3. Offer navigation to each successfully imported QMD anchor.
4. Remember only harmless UI preferences; do not persist external DOCX paths unless
   explicitly required.
5. Document recovery for missing Quarto, unsupported documents, ambiguity, and store
   conflicts.
6. Add telemetry only if the extension already has an explicit telemetry policy;
   otherwise add none.

### Phase 3 acceptance criteria

- Word exports contain readable opening comments, replies, and tracked-change history.
- Import preview accurately separates safe changes from conflicts and skips.
- Selected changes are applied once in a single repository transaction.
- Repeated imports do not duplicate threads or imported replies.
- Native Word reply/resolution support is either verified and tested or explicitly
  documented as unsupported.
- All automated checks pass and representative documents are manually inspected.

## Expected file changes

The exact decomposition may evolve, but likely files are:

- `_extensions/collab-comments/collab-comments.lua`: DOCX branching, store-to-AST
  anchoring, native comment spans, transcript formatting, stable IDs.
- `src/wordComments.ts`: pure Pandoc AST parsing, extraction, identity, classification,
  and import preparation.
- `src/wordComments.test.ts`: unit and regression tests.
- `src/extension.ts`: command registration, file selection, process execution,
  confirmation, repository transaction, and UI refresh.
- `package.json`: command contribution and packaging metadata.
- `tests/quarto/verify.sh`: native DOCX export and round-trip checks.
- `README.md`: user configuration, workflow, limitations, and security guidance.
- Optional `media/` assets and a validated protocol module only if Phase 3 uses a
  webview preview.

Avoid adding generated files under `dist/` or `out/`, and do not refresh checked-in
demo HTML for this feature.

## Verification matrix

### Automated

- Focused TypeScript iteration:

  ```bash
  npm run compile-tests
  node --test out/wordComments.test.js
  ```

- Full TypeScript/extension checks:

  ```bash
  npm test
  ```

- Quarto/DOCX integration checks:

  ```bash
  npm run test:quarto
  ```

- Manifest and production bundle checks:

  ```bash
  npm run package
  ```

### Manual

For representative unresolved and resolved threads:

1. Render DOCX with the feature disabled and verify there are no Word comments.
2. Render with `docx-comments: true` and open the result in Microsoft Word.
3. Confirm author, date, body, highlighted selection, Unicode, multiline content, and
   formatting around the selection.
4. Add a new Word comment, edit an exported comment, reply, resolve, reopen, and delete
   a comment.
5. Import and confirm the documented additive behaviour for every action.
6. Repeat the import and verify it is idempotent.
7. Change the local store between preview and confirmation and verify the import is
   refused.
8. Test repeated source text, formatted source, code blocks, tables, lists, headings,
   cross-paragraph selections, and content omitted from DOCX.
9. Inspect the resulting QMD to verify it is byte-for-byte unchanged.
10. Inspect `.comments/collab-comments.json` and all extension surfaces after import.

## Release and compatibility plan

1. Ship `docx-comments` as opt-in and label import support as conservative/beta in the
   first release.
2. State the minimum Quarto/Pandoc version established by Phase 0 fixtures.
3. Preserve safe no-op behaviour on older unsupported versions and show an actionable
   import error.
4. Do not change the existing store schema for Phase 1 unless implementation evidence
   requires a compatible optional field.
5. If an optional field is later added, keep legacy stores loadable and update all
   boundary validators in TypeScript and Lua together.
6. Keep HTML export, live preview, and non-QMD extension functionality covered by
   regression tests.
7. Gather real reviewed DOCX examples before expanding automatic matching rules.

## Decisions to revisit with evidence

- Minimum Quarto/Pandoc version for reliable comment writing and reading.
- Final numeric ID algorithm and collision behaviour.
- Concrete resource-limit values.
- Whether Phase 1 should support tables and code blocks immediately.
- Whether a changed Word body becomes a reply containing the full body or a labelled
  textual diff.
- Whether Word-native replies are visible through supported Pandoc versions.
- Whether Word resolution should ever be importable.
- Whether a full webview preview is justified over a simpler Quick Pick and output
  channel.
- Whether non-literal formatted selections warrant a deeper QMD AST/source mapping.

These decisions should not weaken conservative anchoring, conflict-aware persistence,
or the default privacy of comment data.
