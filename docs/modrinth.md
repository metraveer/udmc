# Страница мода на Modrinth

Исходник описания для modrinth.com/mod/udmc. Правится здесь, оттуда выкладывается —
чтобы страница не разъезжалась с тем, что мод делает на самом деле.

- **Slug:** `udmc` · **Название:** UDMC
- **Категории:** utility, management
- **Стороны:** нужен и на клиенте, и на сервере (client: required, server: required)
- **Лицензия:** MIT
- **Ссылки:** исходники, трекер и вики — https://github.com/metraveer/udmc
- **Иконка:** `apps/admin-desktop/src-tauri/icons/icon-256.png`
- **Галерея:** экран согласия в самой игре (его видит игрок при первом входе) и обзорная
  страница панели `docs/images/01-server.png` — для владельцев серверов

## Что должно быть сделано до публикации

- [x] **Проверка входа сравнивает версии, а не байты.** Пока сервер требовал побайтового
  совпадения, лаунчер, обновивший мод с Modrinth раньше сервера, запирал игрока снаружи, а наше
  самообновление и лаунчер по очереди возвращали каждый свой файл. Разбор — в
  [client-verification.md](client-verification.md).
- [x] **Матрица пройдена руками на настоящих клиентах** — Fabric 1.21.1, 26.1.2 и 26.2 и
  NeoForge 21.1.248. На каждой: отказ читается целиком, вопрос о проекте показывается с
  отпечатком ключа, согласие принимается, повторный вход даёт `ok`. Автоматический сквозной
  вход по-прежнему умеет только 1.21.1 — библиотека протокола не знает 26.x.

## Краткое описание (summary)

Your server's modpack, installed by the server itself. One file for the server and for every
player: join, accept once, and stay in sync at every launch.

## Описание (body)

**Your server's modpack, installed by the server itself.** Put this one file into `mods`, join
the server, and accept once — it hands over its pack and keeps it current every time you start
the game.

Nothing inside the file is configured for anyone. It is the same jar for the server and for
every player: no keys, no addresses, no project name. The server you join is what tells the
client which pack it is and where to get it.

### For players

1. Install Fabric or NeoForge for the Minecraft version your server runs.
2. Drop this jar into that profile's `mods` folder.
3. Join the server. It introduces itself — the pack's name and the fingerprint of its signing
   key — and asks whether to set this game folder up for it. Nothing is written until you agree.
4. Agree, and the pack downloads. Restart the game once; after that it syncs itself at every
   launch and you never open anything.

Your own mods stay where they are. UDMC removes only files it installed itself, never one you
changed, and every file is checked against the server's signature before anything on disk moves.

One game folder holds one pack. Playing on two UDMC servers means giving the second one its own
Minecraft profile — the mod says so plainly instead of mixing them.

The Fabric modules it needs travel inside the jar. Fabric API does not have to be installed
separately, though it does no harm if it already is.

**Installed through a launcher?** That works. The mod keeps itself current against the server
you play on, and it only ever updates itself when it is *behind* what that server hands out — so
it does not fight your launcher over the file. A server accepts any version that is not older
than its own, so being ahead is fine too.

### For server owners

This mod is one half. The other is **UDMC Control**, a free Windows app: you assemble the pack
there, search Modrinth, CurseForge and GitHub Releases without leaving it, let it check
compatibility, and publish. Players get the update by themselves.

Put the jar in the server's `mods` and start it. On the first run the server creates the
project — its signing keys and a pairing code — and prints the code into the console and into
`config/udmc-pairing.txt`. Enter that code in the panel, and the server is yours.

The app, the guide and the source: **https://github.com/metraveer/udmc**

### What it does, and what it does not

- Downloads pack files from the server you accepted, over HTTP(S), checking an Ed25519
  signature over the file list and the SHA-256 of every file before applying anything.
- Never installs anything before you accept a server, and never overwrites a file you edited.
- Talks to no service of ours. No account, no telemetry, no central server — only the Minecraft
  server you joined.
- Says nothing when there is nothing to say: a launch where your pack is already correct goes
  straight to the game.
- Does nothing on its own: the server has to be running UDMC too.

**Minecraft 1.21.1** (Java 21), **26.1.2** and **26.2** (Java 25). Fabric on all three, NeoForge
on 1.21.1. MIT licence.

---

## Сборка модпака едет с сервера сама

Положите этот файл в `mods`, зайдите на сервер и один раз согласитесь — сервер отдаст свою
сборку и дальше будет держать её свежей при каждом запуске игры.

Внутри файла ничего ни под кого не настроено. Это один и тот же JAR для сервера и для каждого
игрока: ни ключей, ни адресов, ни названия проекта. Что за сборка и откуда её брать, клиенту
рассказывает тот сервер, на который он зашёл.

### Игроку

1. Поставьте Fabric или NeoForge той версии Minecraft, что стоит на сервере.
2. Положите этот JAR в папку `mods` этого профиля.
3. Зайдите на сервер. Он представится — назовёт сборку и отпечаток своего ключа подписи — и
   спросит, настраивать ли эту папку игры под него. До согласия не пишется ничего.
4. Согласитесь: сборка скачается, игру нужно будет перезапустить один раз. Дальше всё
   происходит само, открывать ничего не надо.

Ваши собственные моды остаются на месте. UDMC удаляет только то, что установил сам, и никогда —
изменённый вами файл. Каждый файл проверяется по подписи сервера до того, как что-то поменяется
на диске.

Одна папка игры — одна сборка. Для второго сервера с UDMC заведите отдельный профиль Minecraft:
мод скажет об этом сам, а не смешает их.

Нужные модули Fabric едут внутри JAR — отдельно ставить Fabric API не требуется.

**Ставите через лаунчер?** Это работает. Мод держит себя в актуальном состоянии относительно
того сервера, на котором вы играете, и обновляет себя, только когда **отстал** от него, — с
лаунчером за файл он не спорит. Сервер принимает любую версию не старше своей, так что быть
впереди тоже можно.

### Владельцу сервера

Мод — половина дела. Вторая половина — **UDMC Control**, бесплатное приложение для Windows: в
нём собирают сборку, ищут моды на Modrinth, CurseForge и GitHub, проверяют совместимость и
публикуют. К игрокам обновление приезжает само.

Положите JAR в `mods` сервера и запустите его. При первом запуске сервер заведёт проект — ключи
подписи и код привязки — и напишет код в консоль и в `config/udmc-pairing.txt`. Введите код в
панели, и сервер ваш.

Приложение, инструкция и исходники: **https://github.com/metraveer/udmc**

### Что мод делает и чего не делает

- Скачивает файлы сборки с того сервера, которому вы разрешили, по HTTP(S), проверяя подпись
  Ed25519 над списком файлов и SHA-256 каждого файла до того, как что-то применит.
- Ничего не ставит до вашего согласия и не переписывает файл, который вы правили.
- Не ходит ни в какие наши сервисы. Нет аккаунта, нет телеметрии, нет центрального сервера —
  только тот сервер Minecraft, куда вы зашли.
- Молчит, когда сказать нечего: запуск игры с актуальной сборкой ничем не прерывается.
- Сам по себе не делает ничего: на сервере тоже должен работать UDMC.

**Minecraft 1.21.1** (Java 21), **26.1.2** и **26.2** (Java 25). Fabric — все три, NeoForge —
1.21.1. Лицензия MIT.
