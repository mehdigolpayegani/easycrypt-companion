# Changelog

## Unreleased

- Outline, breadcrumbs and Go to Symbol in Editor for the current file.
- Folding of proofs, theories, sections, modules and comments (`C-c v`).
- Go to Symbol in Workspace over the project and EasyCrypt's library.
- Library files open read-only, with a link to allow editing.
- Go to Definition and hover for declared names, following clones and their renames.
- The goals and response panes are locked, so other files do not open over them.
- The variables and procedures of modules are in the outline, in Go to Symbol and in Go to Definition: `G(A).main`, `M.x`.
- Showing the panes no longer moves the focus through them. VS Code 1.92 or later is required.
- Completion of declared names, with their statement and a note on those that need a `require`; `easycryptCompanion.completion` turns it off.
- Completion also offers the names that clones give, such as `IntID.addrC` and `dbool_ll`.
- The results of `search` and `print` are listed in the outline of the response pane, and each leads to its own lemma.

## 0.1.0

First version.

- Interactive proving through `easycrypt cli -emacs`: next, undo, process to cursor, process to end, retract, interrupt, exit.
- Proof General key bindings (`C-c C-n`, `C-c C-u`, `C-c C-RET`, `C-c C-b`, `C-c C-r`, `C-c C-c`, `C-c C-v`, `C-c C-a C-p`, ...), and Alt-based alternatives.
- Goals and response panes in a Proof General-style three-pane layout.
- Processed and queued regions highlighted; editing inside them retracts.
- Errors shown as diagnostics at the exact location EasyCrypt reports.
- `print`, `search`, `locate` and arbitrary commands from the command palette.
- Weak-check mode toggle in the status bar.
- Syntax highlighting generated from EasyCrypt's lexer.
