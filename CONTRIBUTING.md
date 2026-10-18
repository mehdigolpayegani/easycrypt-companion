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

Every Monday, the Grammar workflow regenerates it from the lexer on EasyCrypt's `main` branch and, if the keywords changed, tests the result and opens a pull request with it; merge it to take the new keywords. It can also be started by hand from the Actions tab. For it to open pull requests, "Allow GitHub Actions to create and approve pull requests" must be on in the repository's Settings, under Actions, General.

`node scripts/corpus-check.mjs file.ec ...` runs whole files through the extension's command splitter and EasyCrypt, to check that both agree on where commands end.

## Releasing

Set the new version in `package.json` and `CHANGELOG.md`, commit, then push a tag with the same number:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The Publish workflow then tests and packages the extension, publishes it to Open VSX, and creates a GitHub release with the version's changelog and the `.vsix` attached. It stops if the tag is not the version in `package.json`.

Open VSX needs no token: this repository and `publish.yml` are registered as the extension's trusted publisher on open-vsx.org (Settings, Trusted Publishers), so the workflow proves who it is with a short-lived token from GitHub. Renaming the workflow file means registering it again.

The Visual Studio Marketplace is updated by hand: download the `.vsix` from the release and upload it on the publisher's page at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), with Update in the extension's menu (New extension, then Visual Studio Code, the first time).

The icon is drawn in `images/icon.svg`; after changing it, regenerate the PNG the package uses:

```sh
rsvg-convert -w 256 -h 256 images/icon.svg -o images/icon.png
```

`npm run package` builds the `.vsix` locally, for trying it with "Install from VSIX...".
