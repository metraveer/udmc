# Project Continuity

Read `CLAUDE.md` first: it holds the working agreement with the owner, including who
decides when a release goes out and what has to be verified before any push.

Durable decisions live in the repository, not in a running conversation:
`CLAUDE.md` for the working agreement and the platform limits that must not be
changed, `docs/client-verification.md` for how the client check is built and
which alternatives were rejected, `CHANGELOG.md` for what shipped and why.
Session journals from earlier stages are kept in `docs/internal/` for history.
Do not mark planned or partially tested features complete.

UDMC Control is a Windows Tauri admin application, not a Minecraft launcher.
Players install the same unmodified udmc-sync JAR the server runs into their existing game profile; the project is learned from the server at login.
Preserve existing projects, credentials, personal files, and managed-file safety.
Use isolated test profiles and worlds; never test against the user's real server.
