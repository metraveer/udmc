# Project Continuity

Read `CLAUDE.md` first: it holds the working agreement with the owner, including who
decides when a release goes out and what has to be verified before any push.

Read `docs/control-next-plan.md` before continuing UDMC development. It records
the user's full 14-item request, acceptance criteria, implementation decisions,
and the latest verified progress. Keep that document current after each tested
milestone and before handing work back. Do not mark planned or partially tested
features complete. Do not lose outstanding items during context compaction.

UDMC Control is a Windows Tauri admin application, not a Minecraft launcher.
Players install a generated client agent JAR into their existing game profile.
Preserve existing projects, credentials, personal files, and managed-file safety.
Use isolated test profiles and worlds; never test against the user's real server.
