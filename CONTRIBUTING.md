# Contributing

## Building and testing

```sh
npm install
npm test            # unit tests, plus integration tests against a real EasyCrypt
npm run test:e2e    # end-to-end tests in VS Code (isolated profile)
```

The integration and end-to-end tests need `easycrypt` on your `PATH` (or in `~/.opam/*/bin`); without it, the integration tests skip themselves. The end-to-end tests use the installed VS Code, or `$VSCODE_EXECUTABLE`.

Press F5 in VS Code to run the extension in a development window.

On GitHub, the Tests workflow runs `npm test` and builds the package on every push to `main` and on pull requests. EasyCrypt is not installed there, so the tests that need it are skipped.

## Highlighting

Highlighting is generated from EasyCrypt's lexer, so new keywords are picked up by regenerating:

```sh
node scripts/gen-grammar.mjs path/to/easycrypt/src/ecLexer.mll
```

`node scripts/corpus-check.mjs file.ec ...` runs whole files through the extension's command splitter and EasyCrypt, to check that both agree on where commands end.

## Releasing

Set the new version in `package.json` and `CHANGELOG.md`, commit, then push a tag with the same number:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The Publish workflow then tests and packages the extension and publishes it to the Visual Studio Marketplace and Open VSX, with the tokens stored in the repository secrets `VSCE_PAT` and `OVSX_PAT`. It stops if the tag is not the version in `package.json`.

`npm run package` builds the `.vsix` locally, for trying it with "Install from VSIX...".
