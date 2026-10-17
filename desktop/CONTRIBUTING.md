# Contributing to Liner

This file is for people sending a change to [tryliner/desktop](https://github.com/tryliner/desktop). Setup for just running the app is in the [README](./README.md).

Read [LICENSE](./LICENSE) before you open a pull request. Liner is source-available. It is not an open-source license. You may fork and modify the code in order to send a fix, a feature, or a docs change back to this repository. You may not publish a competing app, ship your own installer, or lift the signer, lyrics, shader, or interface work into another product. Sending a pull request gives the maintainers the rights described in section 3 of the license, including the right to ship your change inside Liner.

Questions and bug reports go in [issues](https://github.com/tryliner/desktop/issues). Longer design talk can go in [discussions](https://github.com/tryliner/desktop/discussions).

## What to send

A good change does one thing.

- A bug fix with a short note on how you hit it, and how you checked the fix.
- A small feature that fits the app that is already here. If the behavior is new and people will notice it, open an issue first and wait for a maintainer to say they want it.
- Docs, including fixes to this file, when something in the README or here is wrong.

Do not send drive-by reformatting, a dependency bump with no reason, or a rewrite of a folder you were not asked to touch. Do not commit `node_modules/`, `release/`, or secrets.

## Reporting a bug

Search the issue list first. If it is already open, add what you know there.

If you open a new issue, include:

- Liner version (the app version, or the commit you built)
- Operating system
- What you did
- What you expected
- What happened instead

A screen recording or a log line helps. A report that cannot be repeated is hard to act on.

## Set up

You need Node.js 20 or newer, and pnpm or Bun. The lockfile is pnpm's.

```bash
git clone https://github.com/YOUR_NAME/desktop.git
cd desktop
git remote add upstream https://github.com/tryliner/desktop.git
pnpm install
pnpm dev
```

`pnpm dev` starts the Electron app with Vite. `pnpm test` runs Vitest. `pnpm exec tsc -b` typechecks without packaging.

Packaging is optional. You only need it when the change is in the installer or the packaged window:

```bash
pnpm electron:build:win    # Windows installer
pnpm electron:build:linux  # AppImage and deb
pnpm electron:build:mac    # dmg and zip
```

Installers land in `release/`. Do not commit that folder.

The request signer is already compiled into `electron/signer.ts`. A normal UI or Electron change does not need a Wasm rebuild. `pnpm signer:build` points at a script outside this repository.

## Where things live

```
electron/     main process, preload, updater, signer glue
src/          React UI. Most work lands under src/features/
src/shared/   API client, stores, and types used by more than one feature
signer/       Rust source for the request signer
```

Match the style of the file you are editing. Do not add a new pattern for one call site.

## Tests

If you change a function that already has a test, update that test. If you add logic in a store, a parser, or the Electron main process, add a test next to the ones already in that area. A copy change or a layout tweak does not need a test.

Run `pnpm test` before you push. If the change is only in one file, running that file's test is enough, and say so in the pull request.

## Branch, commit, pull request

Start from a current `main`:

```bash
git fetch upstream
git checkout -b feat/short-name upstream/main
```

Use `fix/` for a bug and `feat/` for something new. Docs can use `docs/`.

Commit subjects name the area and the result. This is the shape already used on `main`:

```
feat(electron): keep display awake while music is playing
docs: add a contributing guide
```

The subject is the scope and the result, not a diary of the edit. Small commits on the branch are fine. Maintainers may squash when they merge.

Push the branch to your fork and open the pull request against `tryliner/desktop` `main`. A draft is the right state when you still want a look before it is ready for review.

Use this shape. It is the shape of pull requests that have been merged here.

```
## What
One or two sentences on the change a user would notice.

## Why
The bug or the gap. If an issue exists, link it.

## How
Which files changed, and why that approach.

## Testing
The commands you ran, and what you clicked if the change is in the UI.
```

For a UI change, add a screenshot. One pull request, one problem. If review comments come back, answer them in the thread. You do not need to open a second pull request for the follow-up.

You are responsible for the diff you submit. If a tool wrote part of it, read the diff, run it, and drop anything you cannot explain.
