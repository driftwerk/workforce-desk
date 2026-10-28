# Contributing to Desk

Thanks for helping. This page covers how to get a working build, what we
expect from a pull request, and the licence terms contributions are accepted
under.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree
  the approach before you write the code.
- Security problems go through [SECURITY.md](SECURITY.md), never a public
  issue.
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Contributions are licensed under the [PolyForm Shield License 1.0.0](LICENSE),
like the rest of Desk. By submitting a contribution you also grant the licensor
a perpetual, worldwide, royalty-free, irrevocable licence to use, modify,
sublicense and distribute it under any terms, including in commercial products
and services.

## Development setup

Desk needs the Workforce hub beside it: clone
[driftwerk/workforce](https://github.com/driftwerk/workforce) next to this
repository (the rich renderers come from its `packages/rich`). The
[README](README.md) has the build and run steps.

## Pull requests

- Keep each pull request to one change, with tests for what it changes.
- Run the checks in the README before pushing; CI runs them too.
- Write commit messages as plain sentences that say what changed and why.
