/**
 * Tab Pause — переключение workspace при активации вкладки (Vivaldi mod)
 *
 * Расширение отправляет сообщение chrome.runtime.sendMessage('', {...})
 * Этот mod должен быть подключён в window.html (см. README).
 */
(function () {
  "use strict";

  const NAMESPACE = "TabPause";

  function parseVivExtData(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }
    return {};
  }

  function normalizeWorkspaceId(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function callApi(fn) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (result, error) => {
        if (done) return;
        done = true;
        error ? reject(error) : resolve(result);
      };

      try {
        const ret = fn((result) => {
          const err = chrome.runtime?.lastError;
          finish(result, err || null);
        });
        if (ret !== undefined && typeof ret?.then === "function") {
          ret.then((value) => finish(value, null), (error) => finish(undefined, error));
        } else if (ret !== undefined) {
          finish(ret, null);
        }
      } catch (error) {
        finish(undefined, error);
      }
    });
  }

  async function readWorkspaceId(tabId, tab) {
    if (tab?.workspaceId != null) {
      const direct = normalizeWorkspaceId(tab.workspaceId);
      if (direct != null) return direct;
    }

    const ext = parseVivExtData(tab?.vivExtData);
    const fromTab = normalizeWorkspaceId(ext.workspaceId);
    if (fromTab != null) return fromTab;

    if (!vivaldi?.tabsPrivate?.get) return null;

    try {
      const extra = await callApi((cb) => vivaldi.tabsPrivate.get(tabId, cb));
      const fromExtra = normalizeWorkspaceId(parseVivExtData(extra?.vivExtData).workspaceId);
      if (fromExtra != null) return fromExtra;
    } catch {
      // Ignore.
    }

    return null;
  }

  async function tryActivateWorkspace(windowId, workspaceId) {
    if (workspaceId == null || windowId == null) return false;

    const id = Number(workspaceId);
    const tries = [];

    if (vivaldi?.tabsPrivate?.notifyActiveWorkspace) {
      tries.push(() => callApi((cb) => vivaldi.tabsPrivate.notifyActiveWorkspace(windowId, id, cb)));
    }

    if (vivaldi?.windowPrivate) {
      for (const name of ["setActiveWorkspace", "activateWorkspace", "selectWorkspace", "switchWorkspace"]) {
        if (typeof vivaldi.windowPrivate[name] === "function") {
          tries.push(() => callApi((cb) => vivaldi.windowPrivate[name](windowId, id, cb)));
        }
      }
      if (typeof vivaldi.windowPrivate.update === "function") {
        tries.push(() => callApi((cb) => vivaldi.windowPrivate.update(windowId, { activeWorkspace: id }, cb)));
        tries.push(() => callApi((cb) => vivaldi.windowPrivate.update(windowId, { workspaceId: id }, cb)));
      }
    }

    if (vivaldi?.workspacesPrivate) {
      for (const name of ["setActive", "activate", "select", "switchTo"]) {
        if (typeof vivaldi.workspacesPrivate[name] === "function") {
          tries.push(() => callApi((cb) => vivaldi.workspacesPrivate[name](id, windowId, cb)));
          tries.push(() => callApi((cb) => vivaldi.workspacesPrivate[name](windowId, id, cb)));
        }
      }
    }

    for (const attempt of tries) {
      try {
        await attempt();
        return true;
      } catch {
        // Try next API.
      }
    }

    return false;
  }

  async function activateTab(tabId, windowId, workspaceId) {
    const tab = await chrome.tabs.get(tabId);
    const targetWindowId = windowId ?? tab.windowId;
    const wsId = workspaceId ?? (await readWorkspaceId(tabId, tab));

    if (targetWindowId) {
      await chrome.windows.update(targetWindowId, { focused: true });
    }

    if (wsId != null && targetWindowId) {
      await tryActivateWorkspace(targetWindowId, wsId);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    await chrome.tabs.update(tabId, { active: true });

    const after = await chrome.tabs.get(tabId);
    if (!after.active && wsId != null && targetWindowId) {
      await tryActivateWorkspace(targetWindowId, wsId);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await chrome.tabs.update(tabId, { active: true });
    }

    return { ok: true, tabId, windowId: targetWindowId, workspaceId: wsId };
  }

  function onBridgeMessage(message, _sender, sendResponse) {
    if (!message || message.namespace !== NAMESPACE) return;

    if (message.type === "ACTIVATE_TAB" && message.tabId) {
      activateTab(message.tabId, message.windowId, message.workspaceId)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, reason: error?.message || "activate-failed" }));
      return true;
    }

    if (message.type === "PING") {
      sendResponse({ ok: true, bridge: "TabPause" });
      return true;
    }

    return false;
  }

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(onBridgeMessage);
  }

  if (chrome.runtime?.onMessageExternal) {
    chrome.runtime.onMessageExternal.addListener(onBridgeMessage);
  }

  console.info("[Tab Pause mod] workspace-bridge готов");
})();
