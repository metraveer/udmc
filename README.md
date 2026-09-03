<div align="center">

**English** · [Русский](README.ru.md)

# UDMC

**Ship your Minecraft server's mods to your players — without a custom launcher.**

You build the modpack in a Windows app; players receive it automatically when they start the game they already play.

[![Download](https://img.shields.io/github/v/release/metraveer/udmc?label=download&style=for-the-badge)](../../releases/latest)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue?style=for-the-badge)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?style=for-the-badge&logo=windows)](../../releases/latest)

**Fabric and NeoForge · Minecraft 1.21.1, 26.1.2, 26.2 · English and Russian interface**

<img src="docs/images/01-server.png" alt="The UDMC Control panel: server state, the Needs attention summary, players online" width="880">

</div>

---

## What it solves

You add a mod to the server, and the familiar part begins: post the archive in chat, explain where to put it, chase the people for whom it "doesn't start", and do it all again on the next update.

UDMC removes that step. You publish the pack in the panel, and players get it themselves the next time they launch the game, with file integrity checked and nothing copied by hand.

- **No launcher of your own.** Players keep the client they are used to, third-party launchers included.
- **Mod catalogues inside the panel.** Modrinth, CurseForge and GitHub Releases — search, descriptions, screenshots, and installing into the pack in a couple of clicks.
- **Compatibility checked before you publish.** Missing dependencies, duplicates and wrong sides are found before the server falls over.
- **Nothing extra on the player's machine.** Their own mods stay, server-side files never reach them.
- **One file for everybody.** The mod is the same for the server and for players, with no secrets inside — you can simply post a link to it.

## Five steps to a working setup

1. **Download** [the latest installer](../../releases/latest) and run it.
2. In the app open **Server settings → Download the mod**, pick your game version, and save the file.
3. Put the file into your server's `mods` folder and start it. The server creates a project and writes a **pairing code** — to the console and to `config/udmc-pairing.txt`.
4. Return to the app, open **Server settings → Connection**, enter your server's address and the code. If the RCON password is already there, the field gives way to one button that fetches the code itself.
5. Give players the very same file. There is only one: the server tells the client which modpack it is and where to get it.

That is it: from now on, whatever you publish under "Pack" travels to your players by itself.

The pairing code does not expire and survives restarts, so there is nothing to rush. It stops working the moment the server is paired.

The step-by-step guide is [docs/installation.md](docs/installation.md) (in Russian).

## What it looks like

| Building and publishing a pack | Mod catalogue |
| --- | --- |
| <img src="docs/images/02-pack.png" alt="Draft, published contents and validation tabs" width="420"> | <img src="docs/images/03-catalog.png" alt="Modrinth search with loader and version filters" width="420"> |
| **Server console** | **Administrators** |
| <img src="docs/images/04-console.png" alt="Server console with a command reference" width="420"> | <img src="docs/images/05-devices.png" alt="Administrator list with invitations and approval" width="420"> |

## Features

**Building the pack**
- Draft and publish: nothing reaches players until you publish it.
- Compatibility validation runs by itself on every change and after publishing.
- The check names any mod on the server that adds registry entries but is not handed to players: without it a new player is refused by the game before UDMC can ask them anything.
- Files that arrived on the server outside the panel can be taken under management or left alone.
- Per-file sides: server only, client only, or both.

**Mod catalogues**
- Modrinth and GitHub Releases — no keys, no registration.
- CurseForge — with your own free API key.
- Descriptions, screenshots, dependencies and licences are visible before you install.
- A button to translate descriptions into Russian (with a Yandex Translate key).

**Running the server**
- Process state, TPS, memory, players online.
- A console with the server's commands and a reference; RCON supported.
- Stop and restart with a countdown announced in chat.

**Working together, safely**
- Invitations for other administrators, confirmed by a code.
- Every change is protected against conflicts when several people work at once.
- Ed25519-signed updates; the signing key is created on the server and never sits inside the mod file.
- Project backups: losing the server does not mean losing your players' trust.

## Documentation

The detailed documentation is written in Russian; the source and its comments are in English.

| If you are | Read |
| --- | --- |
| Just starting | [Installation and first run](docs/installation.md) |
| Setting up a server | [Agent configuration](docs/configuration.md), [Administrators and access](docs/administrators.md) |
| Stuck on something | [FAQ](docs/faq.md) |
| A developer | [Architecture](docs/architecture.md), [Agent API](docs/api.md), [Development and tests](docs/development.md) |
| Planning an upgrade | [Compatibility and versions](docs/compatibility-roadmap.md), [Changelog](CHANGELOG.md) |

## Requirements

| Loader | Minecraft | Java |
| --- | --- | --- |
| Fabric | 1.21.1 | 21+ |
| Fabric | 26.1.2, 26.2 | 25+ |
| NeoForge | 1.21.1 | 21+ |

Minecraft below 1.20.2 cannot be supported: the client check at join relies on the configuration
phase, which those versions do not have ([why](docs/supported-minecraft-versions.md)).

The panel runs on Windows 10 or 11. You do not install Java, Node.js or Rust separately — everything it needs is built in.

## Updates

The app checks for updates at startup and offers to install them with one button; downloading and restarting happen on their own. GitHub serves the files, so updates are always available regardless of the author's machine. Every release is signed: the app refuses a package without a valid signature.

Server agents update from the panel — the **Update and restart** button under "Agents and players". Players' clients pick up the new version themselves the next time they start the game.

## Built with AI assistance

This project is developed and maintained with heavy use of AI assistants: they write the code, the tests and the documentation, under human direction and review. Every release goes through automated tests (123 interface and protocol checks, plus Rust and Java test suites) and a manual run against a real Minecraft server.

We think it matters to say so plainly: the code is open, the history is detailed and the decisions are documented — you can check any part of it yourself.

## Contributing

Ideas, bug reports and patches are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE). Minecraft, Fabric, NeoForge, Modrinth and CurseForge are trademarks of their respective owners; this project is not affiliated with them.
