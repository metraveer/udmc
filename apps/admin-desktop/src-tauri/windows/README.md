# NSIS installer

`installer.nsi` is based on the MIT-licensed [Tauri CLI 2.11.4 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi). The upstream license is included in `LICENSE-MIT.txt`. Keep the CLI version pinned and review template changes before upgrading it.

UDMC adds `DetectUdmcUpgrade` and `SkipIfPassiveOrUpgrade`. A matching NSIS registration (publisher, binary name, original directory, main executable, uninstaller, same or older semver) enables in-place installation. It skips welcome, uninstall maintenance and directory pages. Existing process checks, WebView2 installation, progress, UAC and the finish page remain. Downgrades are disabled in Tauri configuration. It deliberately does not set updater/passive flags, which would change dependency checks.

The application has no bundled external resources that need removal across versions. If that changes, add explicit cleanup of obsolete owned resources; never delete arbitrary user files. This is an installer upgrade flow, not a background application updater.

Verify both a clean install and an upgrade using an isolated product name, executable name, registry key and installation directory. Never run upgrade tests against a user's installed Control or reuse its process name: the upstream installer can prompt to terminate a running executable. Check that settings/unrelated sentinel files survive, registry version changes, and no old uninstaller is invoked. Also test an interrupted install, version downgrade and an unrecognized registration when changing this template.

`node scripts/prepare-installer-qa.js` (from the repository root, after `admin:build`) compiles isolated 0.2.1/0.2.2 test packages under `.qa/installer-upgrade/<uuid>`. It only prepares them, never installs or removes them. The payload is a renamed Windows `whoami.exe`, not Control. `fixture.json` identifies the private test registry key and directory. The test packages record upgrade detection and any uninstaller invocation. Keep them out of releases.

Validated on Windows for 0.2.2 with a per-user isolated fixture: clean silent install, normal in-place 0.2.1 to 0.2.2 update (no old uninstaller), retained sentinel and directory, rejected silent downgrade, and same-version passive repair. Production per-machine UAC and interrupted-install recovery were not automated. No production installation was modified.
