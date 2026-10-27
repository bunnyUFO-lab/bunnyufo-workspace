# Security reports

Please report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/bunnyUFO-lab/bunnyufo-workspace/security/advisories/new).
Keep reproduction steps and patches private until we have reviewed the report
and agreed on disclosure. Do not put credentials or personal project content
in a public issue.

Include the app version, operating system, affected feature, expected permission
behavior, and the smallest reproduction you can provide. Remove real tokens,
account details, and private files from logs or screenshots.

We review reports against the latest release. Older releases may need an update
to receive a fix. A public issue acknowledging a report does not mean that the
underlying vulnerability has been resolved.

## Local service and permissions

bunnyUFO Workspace runs on the current user's machine and starts CLI tools as that user.
The CLI's own permission and sandbox settings remain important. Bypass is an
explicit choice and is off by default. bunnyUFO Workspace is not an operating-system
sandbox for arbitrary programs running under the same account.

The local service listens on loopback. Do not expose it through a public
proxy, tunnel, or network interface. Its diagnostic `runtime.json` contains the
process ID and local origin, not credentials of their own.
Keep `.env`, local state and native CLI histories out of shared repositories.
