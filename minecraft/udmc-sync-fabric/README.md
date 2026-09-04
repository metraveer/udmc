# UDMC Sync Agent

Исходники мода для Fabric, а также общий Gradle wrapper и тестовые исходники, которыми пользуется и сборка NeoForge (`../udmc-sync-neoforge`). Панель отдаёт один и тот же JAR серверу и игрокам; внутри нет ни ключей, ни адреса — проект создаётся на сервере при первом запуске.

```powershell
./gradlew.bat build
```

Артефакт создаётся в `build/<minecraft>/libs/udmc-sync-fabric-<minecraft>-<version>.jar` — тот самый файл, который раздаётся игрокам. `npm run minecraft:build` из корня собирает все четыре варианта каталога (`minecraft/agent-catalog.json`) и кладёт их в шаблоны Control.

На сервере агент также предоставляет статистику, консоль команд и управляемую остановку для UDMC Control. Версии Minecraft и Fabric Loader определяются автоматически.

Серверный агент ведёт реестр административных устройств и приглашений. Не передавайте свой ключ устройства другому администратору: он получает доступ по приглашению с подтверждением владельцем. [Доступ](../../docs/administrators.md).

Установка: [../../docs/installation.md](../../docs/installation.md). Конфигурация: [../../docs/configuration.md](../../docs/configuration.md).
