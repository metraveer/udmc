# Публикация на GitHub: пошагово

Инструкция для первой публикации. Все команды выполняются в PowerShell из папки `H:\UDMC`.

## 1. Создать репозиторий

1. Откройте [github.com/new](https://github.com/new).
2. **Repository name**: например `udmc-sync`.
3. **Public**.
4. Ничего не отмечайте в «Add a README file», «.gitignore», «license» — они уже есть в проекте.
5. Нажмите **Create repository**.

## 2. Указать проекту его адрес

Замените `ВАШ-ЛОГИН/udmc-sync` на реальный:

```powershell
node scripts/set-repository.js ВАШ-ЛОГИН/udmc-sync
```

Скрипт пропишет адрес в проверку обновлений и в бейджи README.

## 3. Отправить код

```powershell
git branch -M main
git remote add origin https://github.com/ВАШ-ЛОГИН/udmc-sync.git
git push -u origin main
```

При запросе логина GitHub попросит токен вместо пароля: [создайте его здесь](https://github.com/settings/tokens/new) с правом **repo**.

## 4. Добавить ключ подписи обновлений в секреты

Без этого GitHub не сможет собирать обновления, которые примут установленные копии.

1. Откройте содержимое файла ключа:
   ```powershell
   Get-Content "$env:USERPROFILE\.udmc\updater.key"
   ```
2. В репозитории: **Settings → Secrets and variables → Actions → New repository secret**.
3. Имя: `TAURI_SIGNING_PRIVATE_KEY`, значение: весь текст из шага 1. Сохраните.
4. Ещё один секрет: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, значение оставьте пустым.

> **Храните файл `%USERPROFILE%\.udmc\updater.key` в надёжном месте.** Если он потеряется, установленные у людей копии перестанут получать обновления.

## 5. Оформить витрину репозитория

На главной странице репозитория справа нажмите шестерёнку рядом с «About»:

- **Description**: `Раздача модов Minecraft-сервера на компьютеры игроков без отдельного лаунчера`
- **Website**: оставьте пустым
- **Topics**: `minecraft`, `minecraft-server`, `modpack`, `fabric`, `neoforge`, `modrinth`, `curseforge`, `tauri`, `rust`, `server-administration`
- Галочки: оставьте **Releases**, снимите **Packages** и **Deployments**

**Картинка для ссылок** (как выглядит проект, когда ссылку кидают в чат): **Settings → General → Social preview → Upload an image**, загрузите `docs/images/01-server.png`.

## 6. Выпустить первый релиз

```powershell
git tag v0.15.0
git push origin v0.15.0
```

GitHub соберёт установщик сам (~15 минут). Затем:

1. Откройте **Releases** — там появится черновик.
2. Проверьте, что приложены `UDMC Control_0.15.0_x64-setup.exe`, файл `.sig` и `latest.json`.
3. Впишите описание (можно скопировать раздел 0.15.0 из [CHANGELOG.md](../CHANGELOG.md)).
4. Нажмите **Publish release**.

Готово. С этого момента у всех, кто уже установил приложение, при запуске появится плашка с предложением обновиться.

## Следующие выпуски

```powershell
npm run release:build -- minor   # или patch
git add -A
git commit -m "UDMC Sync 0.16.0"
git push
git tag v0.16.0
git push origin v0.16.0
```

Дальше GitHub соберёт и подготовит черновик релиза — останется нажать **Publish release**.

## Если что-то пошло не так

| Симптом | Причина и решение |
| --- | --- |
| Сборка на GitHub падает | Откройте вкладку **Actions**, найдите красный запуск и раскройте упавший шаг — там будет причина. |
| В релизе нет `.sig` или `latest.json` | Не добавлен секрет `TAURI_SIGNING_PRIVATE_KEY` (шаг 4). |
| Плашка обновления не появляется | Проверьте, что в релизе есть `latest.json` и что релиз опубликован, а не остался черновиком. |
| `git push` просит пароль | GitHub не принимает пароли — нужен токен из шага 3. |
