# Collab Comments

A VS Code extension for collaborative commenting with author tracking, timestamps, and threaded discussions - similar to Overleaf's commenting feature.

## Features

- **Resilient Inline Comments**: Comments use selected text and surrounding context to stay attached as files change
- **Author Tracking**: Every comment records who wrote it and when
- **Threaded Replies**: Reply to comments to create discussion threads
- **Tracked Selection Changes**: Replacing commented text adds an old/new diff to its discussion thread
- **Merge Change History**: Collapse each uninterrupted edit sequence without merging across replies
- **Resolve/Unresolve**: Mark comment threads as resolved when issues are addressed
- **Delete with Confirmation**: Delete entire threads or individual replies with safety confirmations
- **Git-friendly Storage**: Comments are saved in `.comments/collab-comments.json` only while comments exist. A multi-root window keeps one file per workspace folder.
- **External Edit Support**: Valid changes made directly to the JSON file are reloaded instead of overwritten
- **Review Panel**: Use VS Code's native Comments panel for a document-review-style overview
- **Configurable Author**: Set your default name in settings to avoid repeated prompts
- **Any File Type**: Works on any file - not just QMD or Markdown
- **Quarto Live Preview**: Add and manage QMD comments from local HTML preview margins without editing source text

## Usage

### Adding a Comment

**Method 1: Context Menu**
1. Place cursor on a line (or select text)
2. Right-click and choose "Add Comment"
3. Enter your comment text
4. Your name is automatically added (from settings or system username)

**Method 2: Plus Icon**
1. Click the `+` icon in the editor gutter
2. Type your comment and press `Ctrl+Enter`

### Replying to Comments

1. Click inside the comment thread
2. Type your reply in the text box
3. Press `Ctrl+Enter` to submit
4. The reply appears in the same review thread

### Resolving Comments

1. Click the checkmark button in the comment thread title bar
2. The author name changes to "RESOLVED - [Author Name]"
3. Resolved threads show a cross button labelled "Unresolve"

### Deleting Comments

**Delete Entire Thread:**
- Click the trash icon in the comment thread title bar
- Confirm deletion in the modal dialog

**Delete Individual Reply:**
1. Open Command Palette (`Ctrl+Shift+P`)
2. Type "Delete Reply"
3. Select the reply to delete
4. Confirm deletion

### Viewing All Comments

Run `Collab Comments: Open Review Panel` to use VS Code's native Comments panel,
or open the Collab Comments activity-bar view. Select a comment to jump to its
current location. Use the eye button in the Review Comments view title to show
resolved comments; use the crossed-out eye to hide them again. Right-click a
comment in this view to resolve or unresolve it.

## Configuration

Set your default author name to avoid being prompted every time:

1. Open Settings (`Ctrl+,`)
2. Search for "Collab Comments"
3. Set "Default Author" to your name

Or edit `settings.json`:
```json
{
  "commentTracker.defaultAuthor": "Your Name"
}
```

## Commands

| Command | Description |
|---------|-------------|
| `Collab Comments: Add Comment` | Add a new comment at cursor position |
| `Collab Comments: View Comments in Current File` | List comments in the active file |
| `Collab Comments: Delete Comment` | Delete a comment thread from a list |
| `Delete Reply` | Delete an individual reply from a thread |
| `Collab Comments: Open Review Panel` | Open VS Code's native Comments review panel |
| `Show Resolved Comments` | Include resolved threads in the Review Comments view |
| `Hide Resolved Comments` | Return the Review Comments view to unresolved threads only |
| `Merge Tracked Changes` | Keep the oldest deletion and newest addition within each reply interval |

## Storage

Comments are stored in `.comments/collab-comments.json` at the workspace root. In a
multi-root window, each folder has its own file, and a comment is saved in the
folder that contains the commented file. The file and its directory are not
created until the first comment is added, and they are removed when the last
comment in that folder is deleted. The JSON file contains:
- Comment ID, text, author, and timestamp
- File path and line range information
- Threaded replies with their own authors and timestamps
- Resolved status

**Tip:** Commit this file to version control (Git) to share comments with your team!

You may also edit the JSON directly. Save valid JSON and the extension will reload
it. While that document has unsaved changes, comment commands will not write to it.
If the JSON is invalid, the extension reports the error and leaves the file intact.

## Requirements

- VS Code 1.85.0 or higher
- Quarto 1.4 or higher for the optional live-preview filter

## Quarto live-preview comments

Install the Quarto extension once per project (or from a checked-out repository):

```bash
quarto add MikeLydeamore/collab-comments
```

Then enable it in a QMD document or project:

```yaml
filters: [collab-comments]
collab-comments:
  export: false
  show-resolved: false
```

When this VS Code extension is running in the first workspace folder, an HTML
Quarto preview in that workspace discovers a short-lived, local-only bridge. Select
rendered text in the main document, right-click, and choose **Add comment**. The
preview maps the literal selection back to the saved QMD snapshot; ambiguous,
generated, stale, or unsaved selections are rejected rather than guessed. Preview
cards support replies, resolve/unresolve, deletion confirmations, tracked-change
merging, and jumping to the source. The first release never edits QMD text.

The bridge listens only on a random `127.0.0.1` port, requires a per-session bearer
token, and writes a permission-restricted descriptor in the OS temp directory. It
accepts only `.qmd` paths under the current workspace and refuses updates while the
QMD or comment-store JSON is dirty or externally conflicted. Close VS Code to remove
the descriptor immediately; otherwise it expires quickly.

Static HTML stays comment-free by default. To deliberately publish a read-only
snapshot (including comment text), opt in:

```yaml
collab-comments:
  export: true
  show-resolved: false
```

Set `show-resolved: true` to include resolved threads in either exported output or
the local preview. The filter is a no-op for non-HTML formats, revealjs, and other
non-standard outputs should not use this integration.

## Word review round-trip (beta)

Native Word comments are separately opt-in for DOCX output; enabling HTML `export`
does not enable them. With Quarto/Pandoc versions that support portable comment
spans (the automated fixtures use Quarto 1.10 / Pandoc 3.10), configure:

```yaml
filters: [collab-comments]
collab-comments:
  docx-comments: true
  show-resolved: false
```

The filter writes ordinary native Word comments for conservatively mapped literal,
single-block selections. It skips stale ranges, repeated rendered text, overlapping
comments, formatted/structural selections it cannot preserve safely, and comments
outside the rendered document. Word comment text is a literal, read-only flattened
transcript of the opening comment, replies, and tracked changes; it is never parsed
as Markdown or HTML. `show-resolved: true` includes resolved threads and marks their
transcript as resolved. DOCX output never contains the local preview endpoint,
capability token, or bridge descriptor.

To bring a reviewed document back, save and activate the target QMD in the first
workspace folder, then run **Collab Comments: Import Comments from Word…** and pick
the DOCX (it may be outside the workspace). The command reads it with `quarto pandoc
--track-changes=all --to=json`, presents only safe new and changed candidates in a
multi-select review list, then confirms before saving once. It refuses dirty QMD or
comment-store state, ambiguous literal mappings, malformed comment markers,
identity conflicts, oversized files/output, and stale source/store state.
The current defensive limits are a 50 MiB DOCX, 20 MiB Pandoc JSON response, 500
comments, and 32,000 characters each for a comment body or selected text.
QMD import sources and Quarto comment stores are each limited to 20 MiB.

Imports are strictly additive: new Word comments create unresolved local threads;
an unchanged export is skipped; a changed known exported body becomes one labelled
`Word import: <author>` reply. Repeating the same reviewed document does not add that
reply again. Each exported Word ID binds the local thread to the exact transcript
snapshot, so an older untouched export remains recognisable while deleting newer
activity from a current export is treated as a Word edit. A changed-version reply is
timestamped as a new import event after existing thread activity; a new Word thread
retains its Word timestamp. Imports never edit QMD,
overwrite text, delete/resolve local threads,
or treat Word deletions as local deletions. Word-native replies and resolved state
are currently flattened/ignored because Pandoc's portable comment representation
does not expose a reliable relationship model; direct OOXML parsing is intentionally
not used. Detailed safe-skip diagnostics are available in the **Collab Comments:
Word Import** output channel.

## Installation

### From Source

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press `F5` to open a new VS Code window with the extension loaded

## Use Cases

- **Collaborative Writing**: Add feedback on drafts without modifying the original text
- **Code Review**: Leave inline comments for discussion before making changes
- **Document Annotations**: Mark sections that need work or clarification
- **Teaching/Learning**: Instructors can comment on student code or documents
- **Personal Notes**: Track your own thoughts and TODOs within any file

## Tips

- Comments re-anchor using selected text and surrounding context after edits, pulls, and rebases
- Rapid edits to commented text are combined into a single tracked-change entry
- Threads show a merge button only when an uninterrupted interval contains multiple tracked changes
- Use resolve to close discussions without deleting the history
- The JSON file can be committed to Git for team collaboration
- Set a default author name in settings to streamline your workflow

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT
