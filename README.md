# EasyCrypt Companion

Interactive proof development for [EasyCrypt](https://github.com/EasyCrypt/easycrypt) in VS Code, built for people coming from Emacs and Proof General: the same keys, the same goals and response panes, the same step-by-step workflow.

It talks to EasyCrypt through `easycrypt cli -emacs`, the interface Proof General uses, so it works with any EasyCrypt installation. No special build is needed.

## Getting started

1. Install EasyCrypt (for example with opam). The extension finds `easycrypt` on your `PATH` or in `~/.opam/*/bin`; otherwise set `easycryptCompanion.executable`.
2. Open a `.ec` or `.eca` file.
3. Press `C-c C-n` (macOS) or `Alt+Down` to process the first command. The goals and response panes open next to your script.

## Keys

Proof General keys are enabled on macOS by default. On Linux and Windows, `Ctrl+C` is Copy, so they are off unless you set `easycryptCompanion.keybindings.proofGeneral` to `always`. The Alt keys work everywhere.

| Proof General | Alt keys | Command |
|---|---|---|
| `C-c C-n` | `Alt+Down` | Process the next command |
| `C-c C-u` | `Alt+Up` | Undo the last command |
| `C-c C-RET` | `Alt+Right` | Process (or undo) up to the cursor |
| `C-c C-b` | `Alt+End` | Process to the end of the file |
| `C-c C-r` | `Alt+Home` | Retract the whole file |
| `C-c C-c` | | Interrupt EasyCrypt (e.g. a long `smt` call) |
| `C-c C-x` | | Exit EasyCrypt |
| `C-c C-l` | | Reset the three-pane layout |
| `C-x 1` | | Hide or show the goals and response panes |
| `C-c C-p` | | Show the goals |
| `C-c C-.` | | Move the cursor to the end of the processed region |
| `C-c C-v` | | Send any command to EasyCrypt |
| `C-c C-a C-p` | | `print` (defaults to the name under the cursor) |
| `C-c C-f` | | `search` lemmas by operator or pattern, e.g. `(+) (<=)` |
| `C-c C-a C-l` | | `locate` a name |
| `C-c C-;` | | Insert the last response as a comment |
| `C-c C-w` | | Clear the response pane |
| `C-c v` | | Fold or unfold the proof, theory or module at the cursor |

Every command is also in the Command Palette under "EasyCrypt:", and the main ones are buttons in the editor title bar.

The query commands take an optional argument, so you can bind your own keys:

```json
{ "key": "ctrl+c ctrl+a ctrl+s", "command": "easycryptCompanion.search", "args": "(+) (<=)" }
```

## How it behaves

- **Processed region.** What EasyCrypt has checked is highlighted in blue, commands waiting to run in pink (Proof General's colors; change them with `easycryptCompanion.processedBackground` and `easycryptCompanion.queuedBackground` in `workbench.colorCustomizations`).
- **Editing retracts.** Instead of locking the processed region, editing inside it undoes EasyCrypt back to the edit.
- **Errors** appear as a squiggle at the exact place EasyCrypt reports, in the Problems panel, and in the response pane. Processing stops at the first error.
- **Cursor.** After next and undo the cursor moves to the end of the processed region, like Proof General's default `proof-follow-mode`. Set `easycryptCompanion.followMode` to `ignore` to keep it still.
- **Outline and folding.** The Outline view, the breadcrumbs and Go to Symbol in Editor list the lemmas, operators, modules and theories of the file, with the variables and procedures of each module under it. Proofs, theories, sections and modules can be folded. Both follow the text as you type and do not need EasyCrypt to run.
- **Finding lemmas.** Go to Symbol in Workspace (`Cmd+T`, or `Ctrl+T` on Linux and Windows) finds any lemma, operator, type, module, procedure or theory by name, in your project and in EasyCrypt's library, without running EasyCrypt. The library is located with `easycrypt config`; copies of scripts under `_build` and `_opam` are left out.
- **Hiding the panes.** The button at the right of the title bar, or `C-x 1`, hides the goals and response panes so that the script takes the whole width; the same button or key, or the next command, brings them back with the sizes and the text they had (`C-c C-l` brings them back with the default sizes). EasyCrypt keeps its state meanwhile: nothing is processed again. A group maximized with VS Code's View: Toggle Maximize Editor Group is also given back by the next command.
- **The panes stay put.** The goals and response panes sit in locked editor groups, so a file opened while one of them has the focus (with Go to Definition, for example) opens on the script's side instead of covering the pane. VS Code's "Unlock Group" undoes this. When the scripts beside them are all closed, the panes close too, instead of taking their place; the next command opens them again.
- **Definitions and hover.** Go to Definition (`F12`), Peek Definition and hover work on the names of lemmas, operators, types, modules and theories, in scripts and in the goals pane. Names are matched by name, preferring the same file, then the files it requires, then everything else; a qualified name such as `List.size_cat` selects by theory. Clones are followed to the theory they copy, undoing their `rename` clauses, so `IntID.addrC` leads to `addrC` in `ZModule` and `dbool_ll` to `dunifin_ll`; what you see is the original text, before the substitutions of the clone. Variables and procedures of modules are found through their module, arguments left aside (`G(A).main`, `CCA(S, A).O.dec`), and by their bare name inside it; for a module that is a parameter, such as `A.guess`, every procedure of that name is offered. Local variables and symbolic operators such as `+` are not resolved.
- **Search results.** In the response pane, a result of `search` or `print` leads to the lemma EasyCrypt names in the comment above it, such as `(* RField.ofintS *)`, even when several results share a short name. The results are listed in the Outline view and by Go to Symbol in Editor (`Cmd+Shift+O`, or `Ctrl+Shift+O` on Linux and Windows) while the pane has the focus.
- **Completion.** The lemmas, operators, types, modules and theories whose name starts with what you type, or has it at the start of a part (`cat` finds `size_cat`), are suggested with their statement: those of the file from the second letter and, from the third, those of the files it requires, then the rest of the library, marked "needs require" with the theory to require. After a theory or module, as in `List.si` or `G(A).ma`, only its members are listed; right after the dot, press `Ctrl+Space`, since a dot followed by Enter usually ends a command. The words of the open scripts are suggested as before. Names that clones give are suggested too, renamed, as in `IntID.addrC` or `dbool_ll`, with the statement they copy. Turn this off with `easycryptCompanion.completion`, which leaves VS Code's own word suggestions; to stop any list from opening by itself, set `"editor.quickSuggestions": { "other": "off" }` under `"[easycrypt]"`.
- **Library files are read-only.** A file of EasyCrypt's library opens read-only, with an "Allow editing" link at its top. Library files inside your workspace are never locked. Turn this off with `easycryptCompanion.library.readOnly`.
- **Weak-check mode** (`pragma Proofs:weak`, proofs are not checked) is toggled from the status bar item.
- **One EasyCrypt process per file**, started with the file's folder as working directory, so `require` finds neighboring files and `easycrypt.project` is picked up.

## Settings

| Setting | Default | |
|---|---|---|
| `easycryptCompanion.executable` | `easycrypt` | Path to the binary |
| `easycryptCompanion.arguments` | `[]` | Extra arguments, e.g. `["-I", "lib", "-timeout", "10"]` |
| `easycryptCompanion.keybindings.proofGeneral` | `auto` | `auto` (macOS only), `always`, `never` |
| `easycryptCompanion.keybindings.vscodeStyle` | `true` | Alt-based keys |
| `easycryptCompanion.layout` | `threePane` | `threePane`, `beside`, or `manual` |
| `easycryptCompanion.followMode` | `locked` | `locked` or `ignore` |
| `easycryptCompanion.library.readOnly` | `true` | Open library files read-only |
| `easycryptCompanion.completion` | `true` | Suggest declared names while typing |
| `easycryptCompanion.trace` | `false` | Log the conversation with EasyCrypt |

## Other EasyCrypt extensions

If another EasyCrypt extension is installed, both will handle `.ec` files and their keys and highlighting will conflict. The extension warns about this on startup; disable one of them.

## Contributing

To build the extension, run its tests or release a version, see [CONTRIBUTING.md](CONTRIBUTING.md).
