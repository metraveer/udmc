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

**It only does that on a server that runs UDMC.** On any other server the mod sits there doing
nothing: it has no pack of its own and nowhere to get one. If you are here because a server told
you to install it, you are in the right place; if you are looking for a launcher that installs
modpacks by itself, this is not one.

Nothing inside the file is configured for anyone. It is the same jar for the server and for
every player: no keys, no addresses, no project name. The server you join is what tells the
client which pack it is and where to get it.

### For players

1. Install Fabric or NeoForge for the Minecraft version your server runs — the server list
   shows that version next to the server.
2. Drop this jar into that profile's `mods` folder.
3. Join the server. It introduces itself — the pack's name and the fingerprint of its signing
   key — and asks whether to set this game folder up for it. Nothing is written until you agree.
4. Agree, and the pack downloads. Restart the game once — Minecraft only loads mods at startup —
   and from then on it keeps itself in step at every launch, with nothing for you to open.

Your own mods stay where they are. UDMC removes only files it installed itself, never one you
changed, and every file is checked against the server's signature before anything on disk moves.

One game folder holds one pack. Playing on two UDMC servers means giving the second one its own
Minecraft profile — the mod says so plainly instead of mixing them.

The Fabric modules it needs travel inside the jar. Fabric API does not have to be installed
separately, though it does no harm if it already is.

**Installed through a launcher?** That works: the mod updates itself only when it is behind the
server it plays on, so it never fights your launcher over the file, and a server is happy with
any version that is not older than its own.

### For server owners

**The server can run anywhere** — it is a plain Fabric or NeoForge mod on ordinary Java, and a
hosting panel is fine. Only the control application is Windows.

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
- Hears only about the files meant for players. Whatever the server keeps for itself — configs,
  credentials — is never listed to a client and cannot be fetched by hash.
- Says nothing when there is nothing to say: a launch where your pack is already correct goes
  straight to the game.
- Does nothing on its own: the server has to be running UDMC too.
- Leaves when you tell it to: delete the jar and the `udmc-sync` folder beside it. The mods it
  installed stay in `mods` and are yours to keep or remove.

**Minecraft 1.21.1** (Java 21), **26.1.2** and **26.2** (Java 25). Fabric on all three, NeoForge
on 1.21.1. MIT licence.

### How this is built

Most of the code here is written with Claude, from the author's direction: what to build, what to
refuse, and what to test. That is why this project carries Modrinth's AI-generated content label —
the label is on the code and on this page's text.

It is still tested the ordinary way. Every release is walked by hand on real servers and real
clients — a player's first join, on Fabric 1.21.1, 26.1.2 and 26.2 and on NeoForge — and on every
change an automated stand starts a real server and joins it as ten different kinds of client,
from "no mod at all" to "a version newer than the server's" — twice, with and without the whole
Fabric API on the server.

No image here came out of a generator: the icon is Lucide's `package` glyph (ISC) on a plain
background, and the screenshots are of the running program.

---

## Сборка модпака едет с сервера сама

Положите этот файл в `mods`, зайдите на сервер и один раз согласитесь — сервер отдаст свою
сборку и дальше будет держать её свежей при каждом запуске игры.

**Так будет только на сервере, где тоже работает UDMC.** На любом другом мод просто лежит и
ничего не делает: своей сборки у него нет и взять её неоткуда. Если вы пришли сюда потому, что
так велел сервер, — вы по адресу. Если ищете лаунчер, который сам ставит модпаки, — это не он.

Внутри файла ничего ни под кого не настроено. Это один и тот же JAR для сервера и для каждого
игрока: ни ключей, ни адресов, ни названия проекта. Что за сборка и откуда её брать, клиенту
рассказывает тот сервер, на который он зашёл.

### Игроку

1. Поставьте Fabric или NeoForge той версии Minecraft, что стоит на сервере, — её видно прямо
   в списке серверов, рядом с названием.
2. Положите этот JAR в папку `mods` этого профиля.
3. Зайдите на сервер. Он представится — назовёт сборку и отпечаток своего ключа подписи — и
   спросит, настраивать ли эту папку игры под него. До согласия не пишется ничего.
4. Согласитесь: сборка скачается, а игру нужно будет перезапустить один раз — Minecraft грузит
   моды только при старте. Дальше всё держится в порядке само, открывать ничего не надо.

Ваши собственные моды остаются на месте. UDMC удаляет только то, что установил сам, и никогда —
изменённый вами файл. Каждый файл проверяется по подписи сервера до того, как что-то поменяется
на диске.

Одна папка игры — одна сборка. Для второго сервера с UDMC заведите отдельный профиль Minecraft:
мод скажет об этом сам, а не смешает их.

Нужные модули Fabric едут внутри JAR — отдельно ставить Fabric API не требуется.

**Ставите через лаунчер?** Это работает: мод обновляет себя, только когда отстал от сервера, на
котором играет, поэтому за файл с лаунчером не спорит, а сервер принимает любую версию не старше
своей.

### Владельцу сервера

**Сервер может стоять где угодно** — это обычный мод Fabric или NeoForge на обычной Java, панель
хостинга подходит. Windows нужен только приложению управления.

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
- Знает только о файлах для игроков. То, что сервер держит для себя — конфиги, пароли, — клиенту
  не перечисляется и по хешу не выдаётся.
- Молчит, когда сказать нечего: запуск игры с актуальной сборкой ничем не прерывается.
- Сам по себе не делает ничего: на сервере тоже должен работать UDMC.
- Уходит, когда скажете: удалите JAR и папку `udmc-sync` рядом с ним. Моды, которые он поставил,
  остаются в `mods` — оставить их или убрать, решаете вы.

**Minecraft 1.21.1** (Java 21), **26.1.2** и **26.2** (Java 25). Fabric — все три, NeoForge —
1.21.1. Лицензия MIT.

### Как это сделано

Большая часть кода здесь написана с помощью Claude, по направлению автора: что делать, чего не
делать и что проверять. Поэтому у проекта стоит метка Modrinth об AI-контенте — она про код и
про текст этой страницы.

Проверяется он при этом обычным способом. Каждый выпуск проходят руками на настоящих серверах и
настоящих клиентах: первый вход игрока на Fabric 1.21.1, 26.1.2 и 26.2 и на NeoForge. А на каждое
изменение автоматический стенд поднимает настоящий сервер и заходит на него десятью разными
клиентами — от «мода нет вовсе» до «версия новее, чем у сервера» — дважды: с полным Fabric API
на сервере и без него.

Ни одна картинка здесь не вышла из генератора: иконка — глиф `package` из набора Lucide (ISC) на
однотонном фоне, скриншоты — снимки работающей программы.
