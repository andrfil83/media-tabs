/**
 * Tab Pause — пункт «Play / Pause» в ПКМ по вкладке (Vivaldi mod)
 *
 * Обычные расширения Chrome НЕ могут добавить пункт в меню вкладки:
 * contexts: ["tab"] есть только в Chrome 150+, Vivaldi его не поддерживает.
 *
 * Этот mod использует Vivaldi Modders API (vivaldi.menuContent).
 */
(function () {
  "use strict";

  const MENU_NAME = "tab";
  const MENU_TITLE = "Play / Pause";
  // ID корня меню вкладки. Если пункт не появляется — см. README (как найти свой ID).
  const TAB_MENU_ROOT_ID = "334";
  const ACTION_TAG = "TabPauseToggleMedia";

  let menuNodeId = null;
  let ready = false;

  function toggleMediaInTab(tabId) {
    if (!tabId) return;

    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const elements = [...document.querySelectorAll("video, audio")];
        if (elements.length === 0) return { ok: false };

        const playing = elements.filter((el) => !el.paused && !el.ended);
        const target =
          playing.sort((a, b) => (b.currentTime || 0) - (a.currentTime || 0))[0] ||
          elements
            .filter((el) => el.currentTime > 0)
            .sort((a, b) => (b.currentTime || 0) - (a.currentTime || 0))[0] ||
          elements[0];

        if (!target) return { ok: false };

        if (target.paused || target.ended) {
          target.play().catch(() => {});
        } else {
          target.pause();
        }

        return { ok: true };
      },
    }).catch(() => {});
  }

  async function getTabIdFromContextMenu() {
    const tabs = await chrome.tabs.query({ currentWindow: true, highlighted: true });
    if (!tabs.length) return null;

    const highlighted = tabs.filter((tab) => tab.highlighted);
    if (highlighted.length) {
      return highlighted[highlighted.length - 1].id;
    }

    return tabs[tabs.length - 1].id;
  }

  function onMenuAction(action) {
    if (!ready || !action) return;
    if (menuNodeId !== null && action.id !== menuNodeId) return;

    getTabIdFromContextMenu().then((tabId) => toggleMediaInTab(tabId));
  }

  function createMenuItem() {
    if (!vivaldi?.menuContent?.create) {
      setTimeout(createMenuItem, 1000);
      return;
    }

    vivaldi.menuContent.create(
      MENU_NAME,
      TAB_MENU_ROOT_ID,
      0,
      [
        {
          action: ACTION_TAG,
          id: "",
          parameter: "",
          type: "command",
          custom: true,
          title: MENU_TITLE,
        },
      ],
      (success, ids) => {
        if (!success || !ids?.length) {
          console.warn("[Tab Pause mod] Не удалось создать пункт меню. Проверьте TAB_MENU_ROOT_ID.");
          return;
        }

        menuNodeId = ids[0];
        ready = true;
        console.info("[Tab Pause mod] Пункт «Play / Pause» добавлен в меню вкладки.");
      }
    );
  }

  if (vivaldi?.menubarMenu?.onAction) {
    vivaldi.menubarMenu.onAction.addListener(onMenuAction);
  }

  createMenuItem();
})();
