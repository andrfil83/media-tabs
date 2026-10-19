# Media Tabs — mod для меню вкладки (Vivaldi)

## Почему нужен mod

**Обычное расширение Chrome не может** добавить пункт в ПКМ по вкладке в Vivaldi.

API `chrome.contextMenus` с `contexts: ["tab"]` — фича Chrome 150+. Vivaldi её **не реализовал**, поэтому пункт из расширения не появлялся.

Mod использует внутренний API Vivaldi (`vivaldi.menuContent`) — это единственный способ добавить **Play / Pause** в нативное меню вкладки.

## Файлы

| Файл | Назначение |
|------|------------|
| `tab-context-menu.js` | Пункт **Play / Pause** в ПКМ по вкладке |
| `workspace-bridge.js` | Переключение workspace при двойном клике в списке расширения |

Для меню вкладки достаточно **`tab-context-menu.js`**.

## Установка JS-mod

> JS-mods сбрасываются при обновлении Vivaldi и требуют ручной установки.  
> Гайд: https://github.com/tiosgz/modding-vivaldi/blob/master/basics/installation.md

1. Найдите папку Vivaldi, например:
   ```
   C:\Users\<user>\AppData\Local\Vivaldi\Application\<версия>\resources\
   ```
2. Создайте папку `mods\` (если нет)
3. Скопируйте `tab-context-menu.js` и (для workspace) `workspace-bridge.js` в `mods\`
4. Откройте `browser.html` или `window.html` в папке `resources\`
5. Добавьте перед `</body>`:
   ```html
   <script src="mods/tab-context-menu.js"></script>
   <script src="mods/workspace-bridge.js"></script>
   ```
6. Перезапустите Vivaldi
7. ПКМ по вкладке → **Play / Pause**

## Если пункт не появился

ID корня меню вкладки (`334`) может отличаться в вашей версии Vivaldi.

Как найти свой ID:

1. `vivaldi://inspect/#` → Inspect у окна браузера
2. Settings → Appearance → Menu → добавьте любую команду в **Tab** menu
3. В DevTools поставьте breakpoint на `vivaldi.menuContent.create` в bundle.js
4. Посмотрите второй аргумент (`parentId`) — это ваш ID
5. Замените `TAB_MENU_ROOT_ID` в `tab-context-menu.js`

## Как работает

- ПКМ по вкладке → **Play / Pause**
- Работает на **той вкладке**, по которой кликнули (вкладка не переключается)
- Mod сам выполняет pause/play через `chrome.scripting` — расширение Media Tabs для этого **не обязательно**
