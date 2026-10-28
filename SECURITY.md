# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/driftwerk/workforce-desk/security/advisories/new)
(the "Security" tab → "Report a vulnerability").

Include what you found, how to reproduce it, the version or commit you tested,
and the impact you expect. We aim to acknowledge reports within three working
days and to agree a disclosure date with you once a fix is ready.

## Scope

In scope: the code in this repository — the Desk app, its helper and
the local hub set-up it manages. Problems in the Workforce hub itself go to
[driftwerk/workforce](https://github.com/driftwerk/workforce/security/advisories/new).

Out of scope: vulnerabilities in third-party dependencies that are already
public (report those upstream), and issues that need an already-compromised
host or administrator account.

## Supported versions

Security fixes land on `main` and ship in the next release; Desk updates
itself. Run the latest release.

The hub Desk runs is the Workforce hub; its
[threat model](https://github.com/driftwerk/workforce/blob/main/docs/THREAT_MODEL.md)
says what it isolates and what it doesn't.
