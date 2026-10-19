const tabStates = new Map();

const SYSTEM_PAGE = /^(chrome|vivaldi|edge|about|chrome-extension):/;
const MENU_ID = "tab-pause-play";
const STORAGE_KEY = "tabMediaCache";
const LAST_INTERACTION_KEY = "lastInteractionTabId";
const MEDIA_WINDOW_BOUNDS_KEY = "mediaWindowBounds";

const MEDIA_PAGE = "popup.html";
const MEDIA_WINDOW_QUERY = "window=1";
const DEFAULT_MEDIA_WINDOW_BOUNDS = { width: 380, height: 520 };

const mediaWindowIds = new Set();

let lastInteractionTabId = null;

function isTrackableTab(tab) {
  return Boolean(tab.id && tab.url && !SYSTEM_PAGE.test(tab.url));
}

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

function getVivaldiApi() {
  try {
    if (typeof vivaldi !== "undefined") return vivaldi;
    if (typeof globalThis !== "undefined" && globalThis.vivaldi) return globalThis.vivaldi;
  } catch {
    // Not running in Vivaldi.
  }
  return null;
}

function callVivaldiApi(invoke) {
  return new Promise((resolve, reject) => {
    try {
      const returned = invoke((result) => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
      if (returned !== undefined) resolve(returned);
    } catch (error) {
      reject(error);
    }
  });
}

function normalizeWorkspaceId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readWorkspaceIdFromTab(tab) {
  if (!tab) return null;

  const direct = normalizeWorkspaceId(tab.workspaceId);
  if (direct != null) return direct;

  const ext = parseVivExtData(tab.vivExtData);
  return normalizeWorkspaceId(ext.workspaceId);
}

async function getTabWorkspaceId(tabId, tab = null) {
  tab = tab || (await chrome.tabs.get(tabId));

  const cached = tabStates.get(tabId);
  const cachedId = normalizeWorkspaceId(cached?.workspaceId);
  if (cachedId != null) return cachedId;

  const direct = readWorkspaceIdFromTab(tab);
  if (direct != null) return direct;

  const vivaldiApi = getVivaldiApi();
  if (!vivaldiApi?.tabsPrivate?.get) return null;

  try {
    const extra = await callVivaldiApi((cb) => vivaldiApi.tabsPrivate.get(tabId, cb));
    const ext = parseVivExtData(extra?.vivExtData);
    return normalizeWorkspaceId(ext.workspaceId);
  } catch {
    return null;
  }
}

function sendVivaldiBridgeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage("", message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function callVivaldiMethod(fn) {
  try {
    await callVivaldiApi((cb) => fn(cb));
    return true;
  } catch {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  }
}

async function switchVivaldiWorkspace(windowId, workspaceId) {
  if (workspaceId == null || windowId == null) return false;

  const id = Number(workspaceId);
  const vivaldiApi = getVivaldiApi();
  if (!vivaldiApi) return false;

  const attempts = [];

  if (vivaldiApi.tabsPrivate?.notifyActiveWorkspace) {
    attempts.push(() => callVivaldiMethod((cb) => vivaldiApi.tabsPrivate.notifyActiveWorkspace(windowId, id, cb)));
  }

  if (vivaldiApi.windowPrivate) {
    for (const name of ["setActiveWorkspace", "activateWorkspace", "selectWorkspace", "switchWorkspace"]) {
      if (typeof vivaldiApi.windowPrivate[name] === "function") {
        attempts.push(() => callVivaldiMethod((cb) => vivaldiApi.windowPrivate[name](windowId, id, cb)));
      }
    }
    if (typeof vivaldiApi.windowPrivate.update === "function") {
      attempts.push(() => callVivaldiMethod((cb) => vivaldiApi.windowPrivate.update(windowId, { activeWorkspace: id }, cb)));
      attempts.push(() => callVivaldiMethod((cb) => vivaldiApi.windowPrivate.update(windowId, { workspaceId: id }, cb)));
    }
  }

  if (vivaldiApi.workspacesPrivate) {
    for (const name of ["setActive", "activate", "select", "switchTo"]) {
      if (typeof vivaldiApi.workspacesPrivate[name] === "function") {
        attempts.push(() => callVivaldiMethod((cb) => vivaldiApi.workspacesPrivate[name](id, windowId, cb)));
        attempts.push(() => callVivaldiMethod((cb) => vivaldiApi.workspacesPrivate[name](windowId, id, cb)));
      }
    }
  }

  for (const attempt of attempts) {
    if (await attempt()) return true;
  }

  return false;
}

async function activateMediaTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const workspaceId = await getTabWorkspaceId(tabId, tab);

  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  if (workspaceId != null && tab.windowId) {
    let switched = await switchVivaldiWorkspace(tab.windowId, workspaceId);
    if (!switched) {
      const bridgeResult = await sendVivaldiBridgeMessage({
        namespace: "TabPause",
        type: "ACTIVATE_TAB",
        tabId,
        windowId: tab.windowId,
        workspaceId,
      });
      switched = Boolean(bridgeResult?.ok);
    }
    if (switched) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  await chrome.tabs.update(tabId, { active: true });

  let activeTab = await chrome.tabs.get(tabId);
  if (!activeTab.active && workspaceId != null && tab.windowId) {
    await sendVivaldiBridgeMessage({
      namespace: "TabPause",
      type: "ACTIVATE_TAB",
      tabId,
      windowId: tab.windowId,
      workspaceId,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await chrome.tabs.update(tabId, { active: true });
    activeTab = await chrome.tabs.get(tabId);
  }

  if (workspaceId != null) {
    const cached = tabStates.get(tabId);
    if (cached?.hasMedia && cached.workspaceId !== workspaceId) {
      tabStates.set(tabId, { ...cached, workspaceId });
      persistCache();
    }
  }

  return {
    ok: true,
    tabId,
    windowId: tab.windowId,
    workspaceId,
    active: Boolean(activeTab.active),
  };
}

function isUnloaded(tab) {
  return Boolean(tab.discarded || tab.status !== "complete");
}

function resolveIsPlaying(tab, state) {
  if (!state) return false;
  if (isUnloaded(tab)) return false;
  if (!tab.active && !tab.audible) return false;
  return Boolean(state.isPlaying);
}

function withResolvedPlaying(tab, state) {
  if (!state?.hasMedia) return null;
  return { ...state, isPlaying: resolveIsPlaying(tab, state) };
}

async function loadCache() {
  try {
    const data = await chrome.storage.session.get([STORAGE_KEY, LAST_INTERACTION_KEY]);
    const cache = data[STORAGE_KEY] || {};
    for (const [tabId, state] of Object.entries(cache)) {
      tabStates.set(Number(tabId), state);
    }
    lastInteractionTabId = data[LAST_INTERACTION_KEY] ?? null;
  } catch {
    // Session storage unavailable.
  }
  syncStatusPoll();
}

async function persistCache() {
  try {
    const cache = Object.fromEntries(tabStates);
    await chrome.storage.session.set({ [STORAGE_KEY]: cache });
  } catch {
    // Session storage unavailable.
  }
}

async function markLastInteraction(tabId) {
  if (tabId == null) return;
  const changed = lastInteractionTabId !== tabId;
  lastInteractionTabId = tabId;
  try {
    await chrome.storage.session.set({ [LAST_INTERACTION_KEY]: tabId });
  } catch {
    // Session storage unavailable.
  }
  return changed;
}

function classifyInteractionChange(prev, next) {
  if (!next?.hasMedia) return null;

  if (!prev?.hasMedia) {
    return next.isPlaying ? "play" : null;
  }

  const wasPlaying = Boolean(prev.isPlaying);
  const isPlaying = Boolean(next.isPlaying);
  if (!wasPlaying && isPlaying) return "play";
  if (wasPlaying && !isPlaying) return "pause";

  const wasMuted = Boolean(prev.playerMuted ?? prev.muted);
  const isMuted = Boolean(next.playerMuted ?? next.muted);
  if (wasMuted !== isMuted) return "mute";

  const prevVol = normalizeVolume(prev.volume);
  const nextVol = normalizeVolume(next.volume);
  if (prevVol != null && nextVol != null && Math.abs(prevVol - nextVol) >= 0.03) {
    return "volume";
  }

  const prevProg = normalizeProgress(prev.progress);
  const nextProg = normalizeProgress(next.progress);
  const duration = normalizeDuration(next.duration || prev.duration);
  const delta = nextProg - prevProg;
  const absDelta = Math.abs(delta);
  if (absDelta < 0.01) return null;

  if (duration > 0) {
    const elapsedMs = Math.max(0, Date.now() - (prev.updatedAt || 0));
    const expected = elapsedMs / 1000 / duration;
    const slack = Math.max(0.03, expected * 0.5 + 0.02);

    // Natural playback forward — ignore.
    if (wasPlaying && delta >= 0 && delta <= expected + slack) return null;
    // Backward jump or oversized forward jump while paused/playing = seek.
    if (delta < -0.02 || delta > expected + slack) return "seek";
  } else if (absDelta > 0.05) {
    return "seek";
  }

  return null;
}

function pickInteractionTab(changes) {
  if (!changes.length) return null;
  const play = changes.find((entry) => entry.kind === "play");
  if (play) return play.tabId;
  const pause = changes.find((entry) => entry.kind === "pause");
  if (pause) return pause.tabId;
  return changes[changes.length - 1].tabId;
}

async function noteDetectedInteractions(changes) {
  const tabId = pickInteractionTab(changes);
  if (tabId == null) return false;
  const changed = await markLastInteraction(tabId);
  if (changed) notifyPopup();
  return true;
}

function normalizeProgress(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function normalizeCurrentTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function normalizeVolume(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function normalizeTabUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function cacheMatchesTab(tab, cached) {
  if (!cached?.url || !tab?.url) return true;
  return normalizeTabUrl(cached.url) === normalizeTabUrl(tab.url);
}

function tabDisplayTitle(tab, cached) {
  if (tab.title) return tab.title;
  if (cached?.title && cacheMatchesTab(tab, cached)) return cached.title;
  try {
    return new URL(tab.url).hostname.replace(/^www\./, "") || tab.url;
  } catch {
    return tab.url || "Tab";
  }
}

function tabDisplayProgress(tab, state, cached) {
  if (isUnloaded(tab)) return 0;

  const validCache = cached && cacheMatchesTab(tab, cached) ? cached : null;

  if (!tab.active && !tab.audible) {
    return normalizeProgress(state?.progress ?? 0);
  }

  return normalizeProgress(state?.progress ?? validCache?.progress ?? 0);
}

function pruneStaleCache(tabs) {
  const liveIds = new Set(tabs.map((tab) => tab.id));
  let changed = false;

  for (const tabId of [...tabStates.keys()]) {
    if (!liveIds.has(tabId)) {
      tabStates.delete(tabId);
      changed = true;
      continue;
    }

    const tab = tabs.find((entry) => entry.id === tabId);
    if (tab && !cacheMatchesTab(tab, tabStates.get(tabId))) {
      tabStates.delete(tabId);
      changed = true;
    }
  }

  if (changed) {
    persistCache();
    syncStatusPoll();
  }
}

function storeTabState(tabId, state, tab = null) {
  if (state?.hasMedia) {
    const prev = tabStates.get(tabId) || {};
    if (tab && prev.url && !cacheMatchesTab(tab, prev)) {
      tabStates.delete(tabId);
    }
    const base = tabStates.get(tabId) || {};
    tabStates.set(tabId, {
      hasMedia: true,
      controllable: true,
      isPlaying: state.isPlaying ?? base.isPlaying ?? false,
      playerMuted: state.playerMuted ?? state.muted ?? base.playerMuted ?? base.muted ?? false,
      volume: normalizeVolume(state.volume ?? base.volume ?? null),
      progress: normalizeProgress(state.progress ?? base.progress ?? 0),
      duration: normalizeDuration(state.duration ?? base.duration ?? 0),
      currentTime: normalizeCurrentTime(state.currentTime ?? base.currentTime ?? 0),
      title: tab?.title || base.title,
      url: tab?.url || base.url,
      workspaceId: readWorkspaceIdFromTab(tab) ?? base.workspaceId ?? null,
      updatedAt: Date.now(),
    });
  } else {
    tabStates.delete(tabId);
  }
  persistCache();
  syncStatusPoll();
}

const STATUS_POLL_MS = 1000;
let statusPollId = null;

function syncStatusPoll() {
  if (tabStates.size === 0) {
    if (statusPollId !== null) {
      clearInterval(statusPollId);
      statusPollId = null;
    }
    return;
  }
  if (statusPollId !== null) return;

  statusPollId = setInterval(async () => {
    if (tabStates.size === 0) {
      clearInterval(statusPollId);
      statusPollId = null;
      return;
    }

    const before = snapshotTabStates();
    const interactions = [];
    for (const tabId of [...tabStates.keys()]) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (isTrackableTab(tab) && !isUnloaded(tab)) {
          const state = await refreshTabState(tab);
          if (state?.__interaction) {
            interactions.push({ tabId, kind: state.__interaction });
          }
        }
      } catch {
        tabStates.delete(tabId);
        persistCache();
      }
    }
    updateBadge();
    await noteDetectedInteractions(interactions);
    if (snapshotTabStates() !== before) {
      notifyPopupDebounced();
    }
  }, STATUS_POLL_MS);
}

async function execInTab(tabId, action, payload = null, { allFrames = false, lite = false } = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      func: (cmd, data, useLite) => {
        function queryDeep(root, selector) {
          const found = [];
          function walk(node) {
            if (!node) return;
            if (node.querySelectorAll) {
              found.push(...node.querySelectorAll(selector));
            }
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children || []) walk(child);
          }
          walk(root);
          return found;
        }

        function queryAll(root, selector) {
          if (useLite) {
            if (!root) return [];
            return [...(root.querySelectorAll?.(selector) || [])];
          }
          return queryDeep(root, selector);
        }

        function isVisible(el) {
          if (!el?.getBoundingClientRect) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (parseFloat(style.opacity) === 0) return false;
          return true;
        }

        function isInteractiveControl(el) {
          if (!isVisible(el)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) return false;
          if (getComputedStyle(el).pointerEvents === "none") return false;
          return true;
        }

        function controlHint(el) {
          return [
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.getAttribute?.("data-testid"),
            el.className?.toString?.(),
            el.id,
            el.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        }

        function looksLikePlayPauseControl(el) {
          const hint = controlHint(el);
          return (
            /(?:^|[\s_-])(?:play|pause|playpause|play-pause|toggle-play|player-play|player-pause|воспроиз|пауз)(?:[\s_-]|$)/i.test(
              hint
            ) ||
            /(?:^|[\s_.-])(?:play|pause|player-control|play-button|pause-button|vjs-play|ytp-play|plyr)(?:[\s_.-]|$)/i.test(
              hint
            )
          );
        }

        function looksLikeMuteControl(el) {
          const hint = controlHint(el);
          return (
            /(?:^|[\s_-])(?:mute|unmute|sound|volume|audio|звук|без звука|включить звук|выключить звук)(?:[\s_-]|$)/i.test(
              hint
            ) ||
            /(?:^|[\s_.-])(?:mute|unmute|volume|sound|audio)(?:[\s_.-]|$)/i.test(hint) ||
            /turn sound (?:on|off)|sound (?:on|off)/i.test(hint)
          );
        }

        function looksLikePlayControl(el) {
          const hint = controlHint(el);
          if (/(?:^|[\s_-])(?:pause|paused|stop)(?:[\s_-]|$)/i.test(hint) && !/play/i.test(hint)) {
            return false;
          }
          if (
            /(?:^|[\s_-])(?:play|watch|replay|start)(?:[\s_-]|$)/i.test(hint) ||
            /play video|watch video|воспроиз/i.test(hint)
          ) {
            return true;
          }
          if (/playpause|play-pause|toggle-play|playpausebutton/i.test(hint)) {
            const media = getPrimaryMedia();
            return !mediaIsPlaying(media);
          }
          return false;
        }

        function looksLikePauseControl(el) {
          const hint = controlHint(el);
          if (/(?:^|[\s_-])(?:pause|paused|stop)(?:[\s_-]|$)/i.test(hint) || /пауз/i.test(hint)) {
            return true;
          }
          if (/playpause|play-pause|toggle-play|playpausebutton/i.test(hint)) {
            const media = getPrimaryMedia();
            return mediaIsPlaying(media);
          }
          return false;
        }

        function looksLikePlayPauseToggle(el) {
          const hint = controlHint(el);
          return /playpause|play-pause|toggle-play|playpausebutton|player-control|ytp-play-button|vjs-play-control/i.test(
            hint
          );
        }

        function findPlayPauseControls(root) {
          if (!root) return [];
          return queryAll(root, 'button, [role="button"], [role="switch"], a').filter(
            (el) => isInteractiveControl(el) && looksLikePlayPauseControl(el)
          );
        }

        function isVimeoHost() {
          try {
            const host = location.hostname.replace(/^www\./, "");
            return host === "vimeo.com" || host === "player.vimeo.com";
          } catch {
            return false;
          }
        }

        function getVimeoPlayerTargets() {
          const targets = [];
          const seen = new Set();

          function add(node) {
            if (node && !seen.has(node)) {
              seen.add(node);
              targets.push(node);
            }
          }

          for (const iframe of queryAll(document, "iframe")) {
            const src = iframe.src || iframe.getAttribute("src") || "";
            if (/vimeo\.com/i.test(src) || iframe.hasAttribute("data-vimeo-id")) {
              add(iframe);
            }
          }

          for (const node of queryAll(document, "[data-vimeo-id], [data-vimeo-url]")) {
            add(node);
          }

          if (isVimeoHost()) {
            for (const selector of [
              "[data-vimeo-id]",
              "[data-vimeo-url]",
              ".vp-video-wrapper",
              ".vp-player",
              '[data-player="true"]',
              "#player",
            ]) {
              for (const node of queryAll(document, selector)) {
                add(node);
              }
            }
          }

          return targets;
        }

        function tryVimeoSdkVolume(volume) {
          try {
            const Player = window.Vimeo?.Player;
            if (!Player) return false;

            const value = Math.round(Math.min(1, Math.max(0, volume)) * 100);
            for (const target of getVimeoPlayerTargets()) {
              try {
                const player = new Player(target);
                player.setVolume(value).catch(() => {});
                return true;
              } catch {
                // Try the next target.
              }
            }
            return false;
          } catch {
            return false;
          }
        }

        function tryVimeoSdkControl(method) {
          try {
            const Player = window.Vimeo?.Player;
            if (!Player) return false;

            for (const target of getVimeoPlayerTargets()) {
              try {
                const player = new Player(target);
                player[method]().catch(() => {});
                return true;
              } catch {
                // Try the next target.
              }
            }
            return false;
          } catch {
            return false;
          }
        }

        function collectPlayPauseButtons(primary) {
          const buttons = [];
          const seen = new Set();

          function addButtons(root) {
            for (const btn of findPlayPauseControls(root)) {
              if (!seen.has(btn)) {
                seen.add(btn);
                buttons.push(btn);
              }
            }
          }

          if (primary) {
            let node = primary;
            for (let depth = 0; depth < 12 && node; depth++) {
              addButtons(node);
              node = node.parentElement;
            }

            for (const btn of queryAll(document.body, 'button, [role="button"], [role="switch"], a')) {
              if (!looksLikePlayPauseControl(btn) || !isInteractiveControl(btn) || seen.has(btn)) {
                continue;
              }
              if (isNearMedia(btn, primary)) {
                seen.add(btn);
                buttons.push(btn);
              }
            }
          } else {
            addButtons(document.body);
          }

          return buttons;
        }

        function mediaIsPlaying(media) {
          return Boolean(media && !media.paused && !media.ended);
        }

        function clickPagePlayButtons() {
          const selectors = [
            "[data-play-button]",
            ".vp-preview",
            ".plyr__control--overlaid",
            ".vjs-big-play-button",
            '[class*="PlayButton"]',
            '[class*="play-button"]',
            '[class*="play_button"]',
          ];

          for (const selector of selectors) {
            for (const el of queryAll(document, selector)) {
              if (el.matches?.('button, [role="button"], a') && isInteractiveControl(el)) {
                el.click();
                return true;
              }
              const btn = el.querySelector?.('button, [role="button"], a');
              if (btn && isInteractiveControl(btn)) {
                btn.click();
                return true;
              }
            }
          }

          for (const btn of findPlayPauseControls(document.body)) {
            if (isInteractiveControl(btn) && looksLikePlayControl(btn)) {
              btn.click();
              return true;
            }
          }

          return false;
        }

        function clickPlayPause(primary, targetPlaying) {
          if (isVimeoHost()) {
            tryVimeoSdkControl(targetPlaying ? "play" : "pause");
            const afterSdk = getPrimaryMedia() || primary;
            if (afterSdk && mediaIsPlaying(afterSdk) === targetPlaying) {
              return afterSdk;
            }
          }

          const pickControl = targetPlaying ? looksLikePlayControl : looksLikePauseControl;
          let buttons = collectPlayPauseButtons(primary).filter(pickControl);

          if (buttons.length === 0) {
            buttons = collectPlayPauseButtons(primary).filter(looksLikePlayPauseToggle);
          }

          for (const btn of buttons) {
            btn.click();
            const current = getPrimaryMedia() || primary;
            if (mediaIsPlaying(current) === targetPlaying) {
              return current;
            }
          }

          if (targetPlaying && !primary) {
            clickPagePlayButtons();
            const current = getPrimaryMedia();
            if (mediaIsPlaying(current)) return current;
          }

          if (isVimeoHost()) {
            tryVimeoSdkControl(targetPlaying ? "play" : "pause");
          }

          const media = primary || getPrimaryMedia();
          if (media) {
            if (targetPlaying && (media.paused || media.ended)) {
              media.play().catch(() => {});
            } else if (!targetPlaying && !media.paused) {
              media.pause();
            }
          }

          return getPrimaryMedia() || media;
        }

        function hasKnownPlayerControls(root) {
          if (!root?.querySelector && !root?.shadowRoot) return false;
          const selector = [
            ".ytp-play-button",
            ".vjs-play-control",
            ".vjs-big-play-button",
            ".plyr__control--overlaid",
            ".player-play",
            ".player-pause",
            "[data-play-button]",
            '[class*="PlayButton"]',
            '[class*="PauseButton"]',
            '[class*="play-button"]',
            '[class*="play_button"]',
          ].join(", ");
          return queryAll(root, selector).length > 0;
        }

        function findMuteControls(root) {
          if (!root) return [];
          return queryAll(root, 'button, [role="button"], [role="switch"]').filter(
            (el) => isInteractiveControl(el) && looksLikeMuteControl(el)
          );
        }

        function hasMuteControls(root) {
          return findMuteControls(root).length > 0;
        }

        function hasCustomControls(root) {
          if (!root) return false;
          if (hasKnownPlayerControls(root)) return true;
          if (hasMuteControls(root)) return true;

          const candidates = queryAll(root, 'button, [role="button"], [role="switch"], input[type="button"], a');
          for (const el of candidates) {
            if (isInteractiveControl(el) && looksLikePlayPauseControl(el)) {
              return true;
            }
          }
          return false;
        }

        function getPlayerContainer(el) {
          let node = el.parentElement;
          for (let depth = 0; depth < 12 && node; depth++) {
            if (hasCustomControls(node)) return node;
            node = node.parentElement;
          }
          return el.parentElement;
        }

        function findPagePlayerRoot() {
          const selectors = [
            '[class*="player"]',
            '[class*="Player"]',
            '[class*="video"]',
            '[data-player]',
            "#player",
            ".audio-player",
            ".music-player",
            '[class*="playback"]',
          ];

          for (const selector of selectors) {
            for (const node of queryAll(document, selector)) {
              if (hasCustomControls(node)) return node;
            }
          }
          return null;
        }

        function isBackgroundVideo(el) {
          if (el.tagName !== "VIDEO" || el.controls) return false;
          if (isFacebookMediaPage() && isVisible(el)) return false;

          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const container = getPlayerContainer(el);
          const hasControls = hasCustomControls(container);

          if (hasControls) return false;
          if (style.pointerEvents === "none") return true;

          const classHint = `${el.className} ${el.id}`.toLowerCase();
          if (/background|hero|banner|decorative|autoplay/.test(classHint)) return true;

          if (el.autoplay && el.muted) {
            if ((el.currentTime || 0) > 0) return false;
            const embed =
              rect.width < window.innerWidth * 0.65 && rect.height < window.innerHeight * 0.45;
            if (embed) return false;
            return true;
          }

          const coversViewport =
            rect.width >= window.innerWidth * 0.75 && rect.height >= window.innerHeight * 0.4;
          const positioned = style.position === "fixed" || style.position === "absolute";
          if (coversViewport && positioned) return true;

          return false;
        }

        function isControllableMedia(el) {
          if (!(el instanceof HTMLMediaElement)) return false;
          if (el.tagName === "VIDEO" && isBackgroundVideo(el)) return false;
          if (el.controls) return true;

          const container = getPlayerContainer(el);
          if (hasCustomControls(container)) return true;

          if (el.tagName === "VIDEO") {
            if (hasMuteControls(container)) return true;
            if (hasMuteControls(el.parentElement)) return true;
          }

          if (el.tagName === "AUDIO") {
            const pagePlayer = findPagePlayerRoot();
            return Boolean(pagePlayer && hasCustomControls(pagePlayer));
          }

          return false;
        }

        function getAllMediaElements() {
          return queryAll(document, "video, audio");
        }

        function pageAllowsMediaDetection() {
          try {
            const host = location.hostname.replace(/^www\./, "");
            if (host === "youtube.com" || host === "m.youtube.com") {
              return /^\/(watch|shorts|embed|live)\b/.test(location.pathname);
            }
            if (host === "linkedin.com") {
              const path = location.pathname || "/";
              if (/^\/(?:jobs|job|mynetwork|messaging|notifications|search|talent|checkout|premium|settings|help|legal|campaignmanager|sales)(?:\/|$)/i.test(path)) {
                return false;
              }
              return /^\/(?:feed|posts|video|learning|pulse|events|live)(?:\/|$)/i.test(path);
            }
            if (host === "facebook.com" || host === "m.facebook.com") {
              return /^\/(?:reel|reels|watch|videos|video)(?:\/|$)/i.test(location.pathname || "/");
            }
            return true;
          } catch {
            return true;
          }
        }

        function isFacebookMediaPage() {
          try {
            const host = location.hostname.replace(/^www\./, "");
            if (host !== "facebook.com" && host !== "m.facebook.com") return false;
            return /^\/(?:reel|reels|watch|videos|video)(?:\/|$)/i.test(location.pathname || "/");
          } catch {
            return false;
          }
        }

        function isControllableMediaLite(el) {
          if (!(el instanceof HTMLMediaElement)) return false;
          if (el.tagName === "VIDEO" && isBackgroundVideo(el)) return false;
          if (isFacebookMediaPage() && el.tagName === "VIDEO" && isVisible(el)) return true;
          if (el.controls) return true;
          if (isControllableMedia(el)) return true;
          if ((el.currentTime || 0) > 0) {
            const container = getPlayerContainer(el);
            if (hasCustomControls(container) || hasMuteControls(container)) return true;
          }
          return false;
        }

        function getControllableMediaElements() {
          const filter = useLite ? isControllableMediaLite : isControllableMedia;
          return getAllMediaElements().filter(filter);
        }

        function getMuteableMediaElements() {
          const controllable = getControllableMediaElements();
          if (controllable.length > 0) return controllable;
          return getAllMediaElements().filter(
            (el) => el instanceof HTMLMediaElement && isVisible(el) && !isBackgroundVideo(el)
          );
        }

        function getPrimaryMedia() {
          if (!pageAllowsMediaDetection()) return null;

          const elements = getControllableMediaElements();
          if (elements.length === 0) return null;

          const playing = elements.filter((el) => !el.paused && !el.ended);
          if (playing.length > 0) {
            return playing.sort((a, b) => (b.currentTime || 0) - (a.currentTime || 0))[0];
          }

          const paused = elements.filter((el) => el.paused && el.currentTime > 0);
          if (paused.length > 0) {
            return paused.sort((a, b) => (b.currentTime || 0) - (a.currentTime || 0))[0];
          }

          return elements[0];
        }

        function getMediaVolume(el) {
          if (!el) return 1;
          const vol = el.volume;
          return Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1;
        }

        function isMediaMuted(el) {
          if (!el) return true;
          if (el.muted || el.volume === 0) return true;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return true;
          return false;
        }

        function isNearMedia(btn, media) {
          const mediaRect = media.getBoundingClientRect();
          const btnRect = btn.getBoundingClientRect();
          return (
            Math.abs(btnRect.top - mediaRect.top) < 420 &&
            Math.abs(btnRect.left - mediaRect.left) < 640
          );
        }

        function collectMuteButtons(primary) {
          const buttons = [];
          const seen = new Set();

          function addButtons(root) {
            for (const btn of findMuteControls(root)) {
              if (!seen.has(btn)) {
                seen.add(btn);
                buttons.push(btn);
              }
            }
          }

          let node = primary;
          for (let depth = 0; depth < 12 && node; depth++) {
            addButtons(node);
            node = node.parentElement;
          }

          for (const btn of queryAll(document.body, 'button, [role="button"], [role="switch"]')) {
            if (!looksLikeMuteControl(btn) || !isInteractiveControl(btn) || seen.has(btn)) continue;
            if (isNearMedia(btn, primary)) {
              seen.add(btn);
              buttons.push(btn);
            }
          }

          return buttons;
        }

        function clickMuteToggle(primary, targetMuted) {
          const before = isMediaMuted(primary);
          if (before === targetMuted) return before;

          for (const btn of collectMuteButtons(primary)) {
            btn.click();
            const after = isMediaMuted(getPrimaryMedia() || primary);
            if (after === targetMuted) return after;
          }

          return isMediaMuted(getPrimaryMedia() || primary);
        }

        function setMediaElementsMuted(elements, targetMuted) {
          for (const el of elements) {
            el.muted = targetMuted;
            if (!targetMuted) {
              if (el.volume === 0) el.volume = 1;
              el.removeAttribute("muted");
            }
          }
        }

        function applyMediaMute(targetMuted) {
          const elements = getMuteableMediaElements();
          if (elements.length === 0) return null;

          const primary = getPrimaryMedia() || elements[0];
          let currentMuted = clickMuteToggle(primary, targetMuted);

          if (currentMuted !== targetMuted) {
            setMediaElementsMuted(elements, targetMuted);
            currentMuted = isMediaMuted(getPrimaryMedia() || primary);
          }

          if (currentMuted !== targetMuted) {
            currentMuted = clickMuteToggle(primary, targetMuted);
          }

          return {
            ok: true,
            hasMedia: true,
            playerMuted: currentMuted,
            muted: currentMuted,
          };
        }

        function getMediaProgress(primary) {
          if (!primary) return 0;
          if (primary.ended) return 1;

          const duration = primary.duration;
          const current = primary.currentTime || 0;
          if (!Number.isFinite(duration) || duration <= 0) return 0;

          return Math.min(1, Math.max(0, current / duration));
        }

        function mediaState(primary) {
          const duration = primary.duration;
          const currentTime = primary.currentTime || 0;
          return {
            hasMedia: true,
            isPlaying: !primary.paused && !primary.ended,
            playerMuted: isMediaMuted(primary),
            muted: isMediaMuted(primary),
            volume: getMediaVolume(primary),
            progress: getMediaProgress(primary),
            duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
            currentTime: Number.isFinite(currentTime) ? currentTime : 0,
          };
        }

        const primary = getPrimaryMedia();

        if (cmd === "GET_STATE") {
          if (!primary) {
            return { hasMedia: false, isPlaying: false, playerMuted: false, muted: false, progress: 0 };
          }
          return mediaState(primary);
        }

        if (cmd === "PLAY") {
          let media = getPrimaryMedia();
          if (!media) {
            clickPagePlayButtons();
            if (isVimeoHost()) tryVimeoSdkControl("play");
            media = getPrimaryMedia();
          }
          if (!media && !isVimeoHost()) return { ok: false, reason: "no-media" };
          media = clickPlayPause(media, true);
          if (!media) {
            return {
              ok: true,
              hasMedia: true,
              isPlaying: false,
              playerMuted: false,
              muted: false,
              progress: 0,
            };
          }
          return { ok: true, ...mediaState(media) };
        }

        if (cmd === "PAUSE") {
          let media = getPrimaryMedia() || primary;
          if (!media && isVimeoHost()) {
            tryVimeoSdkControl("pause");
            media = getPrimaryMedia();
          }
          if (!media && !isVimeoHost()) return { ok: false, reason: "no-media" };
          media = clickPlayPause(media, false);
          if (!media) {
            return {
              ok: true,
              hasMedia: true,
              isPlaying: false,
              playerMuted: false,
              muted: false,
              progress: 0,
            };
          }
          return { ok: true, ...mediaState(media) };
        }

        if (cmd === "TOGGLE") {
          let media = getPrimaryMedia();
          if (!media) {
            clickPagePlayButtons();
            if (isVimeoHost()) tryVimeoSdkControl("play");
            media = getPrimaryMedia();
          }
          if (!media && !isVimeoHost()) return { ok: false, reason: "no-media" };
          const wantPlaying = !media || media.paused || media.ended;
          media = clickPlayPause(media, wantPlaying);
          if (!media) {
            return {
              ok: true,
              hasMedia: true,
              isPlaying: wantPlaying,
              playerMuted: false,
              muted: false,
              progress: 0,
            };
          }
          return { ok: true, ...mediaState(media) };
        }

        if (cmd === "SEEK") {
          const media = getPrimaryMedia();
          if (!media) return { ok: false, reason: "no-media" };

          const duration = media.duration;
          let next;

          if (typeof data?.position === "number" && Number.isFinite(data.position)) {
            const pos = Math.min(1, Math.max(0, data.position));
            if (Number.isFinite(duration) && duration > 0) {
              next = pos * duration;
              next = Math.min(Math.max(0, next), Math.max(0, duration - 0.05));
            } else {
              next = 0;
            }
          } else {
            const delta = Number(data?.delta) || 0;
            next = (media.currentTime || 0) + delta;
            if (Number.isFinite(duration) && duration > 0) {
              next = Math.min(Math.max(0, next), Math.max(0, duration - 0.05));
            } else {
              next = Math.max(0, next);
            }
          }

          media.currentTime = next;

          const current = getPrimaryMedia() || media;
          return { ok: true, ...mediaState(current) };
        }

        if (cmd === "MUTE") {
          const targetMuted = Boolean(data?.muted);
          const result = applyMediaMute(targetMuted);
          if (!result) return { ok: false, reason: "no-media" };
          const current = getPrimaryMedia();
          if (current) {
            return { ...result, volume: getMediaVolume(current) };
          }
          return result;
        }

        if (cmd === "SET_VOLUME") {
          const target = Math.min(1, Math.max(0, Number(data?.volume)));
          if (!Number.isFinite(target)) return { ok: false, reason: "bad-volume" };

          const elements = getMuteableMediaElements();
          let primary = getPrimaryMedia() || elements[0];

          if (!primary && isVimeoHost()) {
            tryVimeoSdkVolume(target);
            primary = getPrimaryMedia();
          }

          if (!primary && elements.length === 0) {
            return { ok: false, reason: "no-media" };
          }

          for (const el of elements) {
            el.volume = target;
            if (target <= 0) {
              el.muted = true;
            } else {
              el.muted = false;
              el.removeAttribute("muted");
            }
          }

          if (isVimeoHost()) tryVimeoSdkVolume(target);

          const current = getPrimaryMedia() || primary;
          return { ok: true, ...mediaState(current) };
        }

        function looksLikeDislikeHint(hint) {
          return /dislike|not interested|дизлайк|не нравится/i.test(hint);
        }

        function controlHint(el) {
          return [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.getAttribute("data-tooltip"),
            el.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .trim();
        }

        function looksLikeLikeControl(el) {
          const hint = controlHint(el);
          if (hint) {
            if (looksLikeDislikeHint(hint)) return false;
            if (/(?:^|[\s,.(])(?:like|thumbs up|нравится)(?:[!)\s,.]|$)/i.test(hint)) return true;
          }
          if (
            el.closest?.(
              "like-button-view-model, ytd-like-button-renderer, #segmented-like-button, [class*='like-button']"
            )
          ) {
            return !el.closest("[class*='dislike'], [id*='dislike']");
          }
          return false;
        }

        function collectLikeButtons() {
          const buttons = [];
          const seen = new Set();

          for (const host of queryAll(
            document,
            "like-button-view-model, ytd-like-button-renderer, #segmented-like-button"
          )) {
            for (const btn of queryAll(host, "button, [role='button']")) {
              if (!isInteractiveControl(btn) || seen.has(btn)) continue;
              seen.add(btn);
              buttons.push(btn);
            }
          }

          for (const btn of queryAll(document.body, 'button, [role="button"]')) {
            if (!looksLikeLikeControl(btn) || !isInteractiveControl(btn) || seen.has(btn)) continue;
            seen.add(btn);
            buttons.push(btn);
          }

          return buttons;
        }

        function isLikeActive(btn) {
          return btn.getAttribute("aria-pressed") === "true" || btn.getAttribute("aria-selected") === "true";
        }

        function applyLike() {
          const buttons = collectLikeButtons();
          if (buttons.length === 0) return { ok: false, reason: "no-like-button" };

          for (const btn of buttons) {
            if (isLikeActive(btn)) {
              return { ok: true, alreadyLiked: true };
            }
          }

          buttons[0].click();
          return { ok: true, liked: true };
        }

        if (cmd === "LIKE") {
          return applyLike();
        }

        return null;
      },
      args: [action, payload, lite],
    });

    return pickFrameResult(results);
  } catch {
    return null;
  }
}

function pickFrameResult(results) {
  const entries = results || [];
  const frames = entries.map((entry) => entry.result).filter(Boolean);
  if (frames.length === 0) return null;

  const playing = frames.find((frame) => frame.hasMedia && frame.isPlaying);
  if (playing) return playing;

  const withMedia = frames.find((frame) => frame.hasMedia);
  if (withMedia) return withMedia;

  const mainResult = entries[0]?.result;
  if (mainResult && mainResult.hasMedia === false) {
    return mainResult;
  }

  return null;
}

function waitForTabReady(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(value);
    };

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish(true);
      }
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((tab) => {
      if (!tab.discarded && tab.status === "complete") {
        finish(true);
      }
    }).catch(() => finish(false));
  });
}

async function ensureTabLoaded(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.discarded && tab.status === "complete") {
    return true;
  }

  if (tab.discarded) {
    await chrome.tabs.reload(tabId);
  }

  return waitForTabReady(tabId);
}

async function probeTabState(tab, { lite = true } = {}) {
  return execInTab(tab.id, "GET_STATE", null, { lite });
}

const MEDIA_SITE =
  /(?:youtube\.com\/(?:watch|shorts|embed|live)|music\.youtube)|youtu\.be|vimeo\.com|music\.yandex|spotify\.com|soundcloud\.com/i;

const LINKEDIN_NON_MEDIA_PATH =
  /^\/(?:jobs|job|mynetwork|messaging|notifications|search|talent|checkout|premium|settings|help|legal|campaignmanager|sales)(?:\/|$)/i;

const LINKEDIN_MEDIA_PATH =
  /^\/(?:feed|posts|video|learning|pulse|events|live)(?:\/|$)/i;

const FACEBOOK_MEDIA_PATH =
  /^\/(?:reel|reels|watch|videos|video)(?:\/|$)/i;

function isLinkedInMediaPath(pathname) {
  if (!pathname) return false;
  if (LINKEDIN_NON_MEDIA_PATH.test(pathname)) return false;
  return LINKEDIN_MEDIA_PATH.test(pathname);
}

function isFacebookMediaPath(pathname) {
  return FACEBOOK_MEDIA_PATH.test(pathname || "/");
}

function isMediaPageUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtube.com" || host === "m.youtube.com") {
      return /^\/(watch|shorts|embed|live)\b/.test(parsed.pathname);
    }
    if (host === "youtu.be" || host === "music.youtube.com") return true;
    if (host === "linkedin.com") return isLinkedInMediaPath(parsed.pathname);
    if (host === "facebook.com" || host === "m.facebook.com") {
      return isFacebookMediaPath(parsed.pathname);
    }

    return MEDIA_SITE.test(url);
  } catch {
    return MEDIA_SITE.test(url);
  }
}

function isLikelyMediaTab(tab) {
  return isMediaPageUrl(tab.url);
}

function isVimeoUrl(url) {
  return /vimeo\.com/i.test(url || "");
}

function execMediaControlOpts(tab) {
  return isVimeoUrl(tab?.url) ? { lite: false } : { lite: true };
}

async function execMediaControl(tabId, action, payload, tab) {
  let result = await execInTab(tabId, action, payload, execMediaControlOpts(tab));

  if (!isVimeoUrl(tab.url) || !result?.ok || !result?.hasMedia) {
    return result;
  }

  const needsRetry =
    (action === "PAUSE" && result.isPlaying) ||
    (action === "PLAY" && !result.isPlaying);

  if (!needsRetry) {
    return result;
  }

  await execInTab(tabId, action, payload, { lite: false, allFrames: true });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const state = await execInTab(tabId, "GET_STATE", null, { lite: false });
  if (state?.hasMedia) {
    result = { ...result, ...state, ok: true };
  }

  return result;
}

async function discoverMediaTabs(ordered) {
  const seen = new Set();
  const candidates = [];

  for (const tab of ordered) {
    if (tab.audible || isLikelyMediaTab(tab) || tabStates.has(tab.id)) {
      if (!seen.has(tab.id)) {
        seen.add(tab.id);
        candidates.push(tab);
      }
    }
  }

  await runPool(candidates, (tab) => refreshTabState(tab), 4);
}

async function refreshTabState(tab) {
  if (!isTrackableTab(tab)) return null;

  const cached = tabStates.get(tab.id);
  const prev = cached ? { ...cached } : null;

  if (isUnloaded(tab)) {
    const match = cached?.hasMedia && cached?.controllable && cacheMatchesTab(tab, cached) ? cached : null;
    return withResolvedPlaying(tab, match);
  }

  let state = await probeTabState(tab, { lite: true });

  if (!state?.hasMedia) {
    state = await probeTabState(tab, { lite: false });
  }

  if (!state?.hasMedia && cached?.controllable) {
    state = await execInTab(tab.id, "GET_STATE", null, { lite: false, allFrames: true });
  }

  if (state?.hasMedia) {
    storeTabState(tab.id, state, tab);
    const workspaceId = await getTabWorkspaceId(tab.id, tab);
    if (workspaceId != null) {
      const cached = tabStates.get(tab.id);
      if (cached && cached.workspaceId !== workspaceId) {
        tabStates.set(tab.id, { ...cached, workspaceId });
        persistCache();
      }
    }
    const kind = classifyInteractionChange(prev, tabStates.get(tab.id));
    if (kind) {
      state = { ...state, __interaction: kind };
    }
    return state;
  }

  if (state && state.hasMedia === false) {
    if (cached?.controllable && isMediaPageUrl(tab.url) && cacheMatchesTab(tab, cached)) {
      const paused = { ...cached, isPlaying: false };
      storeTabState(tab.id, paused, tab);
      const kind = classifyInteractionChange(prev, paused);
      const resolved = withResolvedPlaying(tab, paused);
      if (kind && resolved) resolved.__interaction = kind;
      return resolved;
    }
    tabStates.delete(tab.id);
    persistCache();
    syncStatusPoll();
    return state;
  }

  return withResolvedPlaying(
    tab,
    cached?.hasMedia && cached?.controllable && cacheMatchesTab(tab, cached) ? cached : null
  );
}

async function playTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    return { ok: false, reason: "load-failed" };
  }

  const result = await execMediaControl(tabId, "PLAY", null, tab);
  if (result?.hasMedia) {
    storeTabState(tabId, result, tab);
  }
  await markLastInteraction(tabId);
  updateBadge();
  return { ...result, ...(await getTabUiState(tabId, result, tab)) };
}

async function pauseTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    return { ok: false, reason: "load-failed" };
  }

  const result = await execMediaControl(tabId, "PAUSE", null, tab);
  if (result?.hasMedia) {
    storeTabState(tabId, result, tab);
  }
  await markLastInteraction(tabId);
  updateBadge();
  return { ...result, ...(await getTabUiState(tabId, result, tab)) };
}

async function pauseAllMediaTabs() {
  const items = await getMediaTabs(false);
  const targets = items.filter((item) => item.isPlaying && !item.unloaded);

  await runPool(targets, (item) => pauseTab(item.tabId), 4);
  updateBadge();
  notifyPopupDebounced();

  return { ok: true, count: targets.length };
}

async function muteAllMediaTabs() {
  const items = await getMediaTabs(false);
  const loaded = items.filter((item) => !item.unloaded);
  const allMuted = loaded.length > 0 && loaded.every((item) => item.muted);
  const targetMuted = !allMuted;
  const targets = allMuted ? loaded : loaded.filter((item) => !item.muted);

  if (targets.length > 0) {
    await runPool(targets, (item) => setTabMuted(item.tabId, targetMuted), 4);
  }
  notifyPopupDebounced();

  return { ok: true, count: targets.length, muted: targetMuted };
}

async function setVolumeAllMediaTabs(volume) {
  const normalized = normalizeVolume(volume);
  if (normalized === null) {
    return { ok: false, reason: "bad-volume" };
  }

  const items = await getMediaTabs(false);
  const loaded = items.filter((item) => !item.unloaded);

  if (loaded.length > 0) {
    await runPool(loaded, (item) => setTabVolume(item.tabId, normalized), 4);
  }
  notifyPopupDebounced();

  return { ok: true, count: loaded.length, volume: normalized };
}

async function likeTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "no-tab" };
  }

  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    return { ok: false, reason: "load-failed" };
  }

  let result = await execInTab(tabId, "LIKE", null, { lite: false });
  if (!result?.ok) {
    result = await execInTab(tabId, "LIKE", null, { allFrames: true, lite: false });
  }

  await markLastInteraction(tabId);
  return result || { ok: false, reason: "no-like-button" };
}

async function closeMediaTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    return { ok: false, reason: "close-failed", tabId };
  }

  tabStates.delete(tabId);
  persistCache();
  syncStatusPoll();
  updateBadge();
  notifyPopupDebounced();

  if (lastInteractionTabId === tabId) {
    lastInteractionTabId = null;
    chrome.storage.session.remove(LAST_INTERACTION_KEY).catch(() => {});
  }

  return { ok: true, tabId };
}

async function toggleTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    return { ok: false, reason: "load-failed" };
  }

  const opts = execMediaControlOpts(tab);
  const before = await execInTab(tabId, "GET_STATE", null, opts);
  let result = await execMediaControl(tabId, "TOGGLE", null, tab);
  if (!result) return { ok: false, reason: "inject-failed" };

  if (isVimeoUrl(tab.url) && before?.hasMedia && result?.hasMedia) {
    if (before.isPlaying && result.isPlaying) {
      result = await execMediaControl(tabId, "PAUSE", null, tab);
    } else if (!before.isPlaying && !result.isPlaying) {
      result = await execMediaControl(tabId, "PLAY", null, tab);
    }
  }

  if (result.hasMedia) {
    storeTabState(tabId, result, tab);
  } else if (result.ok) {
    const state = await execInTab(tabId, "GET_STATE", null, { lite: true });
    if (state) storeTabState(tabId, state, tab);
  } else {
    tabStates.delete(tabId);
    persistCache();
    syncStatusPoll();
  }

  await markLastInteraction(tabId);
  updateBadge();
  return { ...result, ...(await getTabUiState(tabId, result, tab)) };
}

async function seekTab(tabId, { delta, position } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    return { ok: false, reason: "load-failed" };
  }

  const result = await execInTab(tabId, "SEEK", { delta, position }, { lite: true });
  if (result?.hasMedia) {
    storeTabState(tabId, result, tab);
  }

  await markLastInteraction(tabId);
  updateBadge();
  return { ...result, ...(await getTabUiState(tabId, result, tab)) };
}

async function setTabMuted(tabId, muted) {
  let tab = await chrome.tabs.get(tabId);

  if (!muted && tab.mutedInfo?.muted) {
    try {
      await chrome.tabs.update(tabId, { muted: false });
      tab = await chrome.tabs.get(tabId);
    } catch {
      // Ignore tab unmute errors and still try the player.
    }
  }

  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    await markLastInteraction(tabId);
    return { ok: false, reason: "load-failed" };
  }

  const result = await execInTab(tabId, "MUTE", { muted }, { allFrames: true });

  if (result?.hasMedia) {
    storeTabState(tabId, result, tab);
  }

  await markLastInteraction(tabId);
  updateBadge();
  const playerMuted = result?.playerMuted ?? result?.muted ?? muted;
  const tabMuted = Boolean(tab.mutedInfo?.muted);
  const volume =
    normalizeVolume(result?.volume ?? tabStates.get(tabId)?.volume) ??
    (playerMuted || tabMuted ? 0 : 1);
  return {
    ok: Boolean(result?.ok),
    tabId,
    hasMedia: Boolean(result?.hasMedia),
    isPlaying: resolveIsPlaying(tab, tabStates.get(tabId) || {}),
    playerMuted,
    tabMuted,
    muted: playerMuted || tabMuted,
    volume,
    unloaded: isUnloaded(tab),
    progress: normalizeProgress(tabStates.get(tabId)?.progress ?? result?.progress ?? 0),
  };
}

async function setTabVolume(tabId, volume) {
  const normalized = normalizeVolume(volume);
  if (normalized === null) {
    return { ok: false, reason: "bad-volume" };
  }

  let tab = await chrome.tabs.get(tabId);

  if (normalized > 0 && tab.mutedInfo?.muted) {
    try {
      await chrome.tabs.update(tabId, { muted: false });
      tab = await chrome.tabs.get(tabId);
    } catch {
      // Ignore tab unmute errors and still try the player.
    }
  }

  if (isUnloaded(tab) && !(await ensureTabLoaded(tabId))) {
    await markLastInteraction(tabId);
    return { ok: false, reason: "load-failed" };
  }

  const result = await execInTab(tabId, "SET_VOLUME", { volume: normalized }, { allFrames: true });

  if (result?.hasMedia) {
    storeTabState(tabId, result, tab);
  }

  await markLastInteraction(tabId);
  updateBadge();

  const playerMuted = result?.playerMuted ?? result?.muted ?? normalized <= 0;
  const tabMuted = Boolean(tab.mutedInfo?.muted);
  const storedVolume =
    normalizeVolume(result?.volume ?? tabStates.get(tabId)?.volume) ?? normalized;

  return {
    ok: Boolean(result?.ok),
    tabId,
    hasMedia: Boolean(result?.hasMedia),
    isPlaying: resolveIsPlaying(tab, tabStates.get(tabId) || {}),
    playerMuted,
    tabMuted,
    muted: playerMuted || tabMuted,
    volume: storedVolume,
    unloaded: isUnloaded(tab),
    progress: normalizeProgress(tabStates.get(tabId)?.progress ?? result?.progress ?? 0),
  };
}

async function getTabVolume(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "no-tab" };
  }

  const cached = tabStates.get(tabId);
  if (isUnloaded(tab)) {
    const playerMuted = Boolean(cached?.playerMuted);
    const tabMuted = Boolean(tab.mutedInfo?.muted);
    const muted = playerMuted || tabMuted;
    const volume = normalizeVolume(cached?.volume) ?? (muted ? 0 : 1);
    return { ok: true, tabId, volume, muted, playerMuted, tabMuted };
  }

  const result = await execInTab(tabId, "GET_STATE", null, { lite: true });
  if (result?.hasMedia) {
    storeTabState(tabId, result, tab);
  }

  const playerMuted = Boolean(result?.playerMuted ?? result?.muted ?? cached?.playerMuted);
  const tabMuted = Boolean(tab.mutedInfo?.muted);
  const muted = playerMuted || tabMuted;
  const volume = normalizeVolume(result?.volume ?? cached?.volume) ?? (muted ? 0 : 1);

  return { ok: true, tabId, volume, muted, playerMuted, tabMuted };
}

async function updateBadge() {
  let playing = 0;

  for (const [tabId, state] of tabStates.entries()) {
    if (!state.hasMedia || !state.isPlaying) continue;

    try {
      const tab = await chrome.tabs.get(Number(tabId));
      if (resolveIsPlaying(tab, state)) playing += 1;
    } catch {
      // Tab closed.
    }
  }

  if (playing > 0) {
    chrome.action.setBadgeText({ text: String(playing) });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function notifyPopup() {
  try {
    chrome.runtime.sendMessage({ type: "MEDIA_STATE_CHANGED" }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Popup closed.
  }
}

let notifyPopupTimer = null;

function notifyPopupDebounced() {
  clearTimeout(notifyPopupTimer);
  notifyPopupTimer = setTimeout(notifyPopup, 900);
}

function snapshotTabStates() {
  return JSON.stringify([...tabStates.entries()].sort((a, b) => a[0] - b[0]));
}

async function runPool(items, worker, limit = 4) {
  const results = new Array(items.length);
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

function buildMediaTabItem(tab, state) {
  if (!state?.hasMedia) return null;
  if (!isMediaPageUrl(tab.url) && !tab.audible) return null;
  if (!cacheMatchesTab(tab, state)) return null;

  const cached = tabStates.get(tab.id);
  const unloaded = isUnloaded(tab);
  const playerMuted = Boolean(
    state.playerMuted ?? state.muted ?? cached?.playerMuted ?? cached?.muted
  );
  const tabMuted = Boolean(tab.mutedInfo?.muted);
  const muted = playerMuted || tabMuted;
  const volume = normalizeVolume(state?.volume ?? cached?.volume) ?? (muted ? 0 : 1);

  return {
    tabId: tab.id,
    title: tabDisplayTitle(tab, cached),
    favIconUrl: tab.favIconUrl || "",
    isPlaying: resolveIsPlaying(tab, state),
    playerMuted,
    tabMuted,
    muted,
    volume,
    unloaded,
    progress: tabDisplayProgress(tab, state, cached),
    duration: normalizeDuration(state?.duration ?? cached?.duration ?? 0),
    currentTime: normalizeCurrentTime(state?.currentTime ?? cached?.currentTime ?? 0),
    lastInteraction: tab.id === lastInteractionTabId,
    index: tab.index,
    windowId: tab.windowId,
    workspaceId: cached?.workspaceId ?? null,
  };
}

async function getTabUiState(tabId, state, tab = null) {
  const tabInfo = tab || (await chrome.tabs.get(tabId));
  const cached = tabStates.get(tabId);
  const playerMuted = Boolean(state?.playerMuted ?? state?.muted ?? cached?.playerMuted);
  const tabMuted = Boolean(tabInfo.mutedInfo?.muted);
  const muted = playerMuted || tabMuted;
  const volume = normalizeVolume(state?.volume ?? cached?.volume) ?? (muted ? 0 : 1);

  return {
    tabId,
    hasMedia: Boolean(state?.hasMedia ?? cached?.hasMedia),
    isPlaying: resolveIsPlaying(tabInfo, state ?? cached),
    playerMuted,
    tabMuted,
    muted,
    volume,
    unloaded: isUnloaded(tabInfo),
    progress: normalizeProgress(state?.progress ?? cached?.progress ?? 0),
    duration: normalizeDuration(state?.duration ?? cached?.duration ?? 0),
    currentTime: normalizeCurrentTime(state?.currentTime ?? cached?.currentTime ?? 0),
    lastInteraction: tabId === lastInteractionTabId,
  };
}

let backgroundRefreshRunning = false;

async function refreshMediaTabsInBackground(orderedTabs) {
  if (backgroundRefreshRunning) return;
  backgroundRefreshRunning = true;

  try {
    const before = snapshotTabStates();
    const candidates = orderedTabs.filter(
      (tab) => tabStates.has(tab.id) || tab.audible || isLikelyMediaTab(tab)
    );
    const results = await runPool(candidates, (tab) => refreshTabState(tab), 4);
    const interactions = [];
    for (let i = 0; i < candidates.length; i++) {
      const state = results[i];
      if (state?.__interaction) {
        interactions.push({ tabId: candidates[i].id, kind: state.__interaction });
      }
    }
    await noteDetectedInteractions(interactions);
    if (snapshotTabStates() !== before) {
      notifyPopupDebounced();
    }
  } finally {
    backgroundRefreshRunning = false;
  }
}

function getMediaWindowUrl() {
  return `${chrome.runtime.getURL(MEDIA_PAGE)}?${MEDIA_WINDOW_QUERY}`;
}

function isMediaWindowTab(tab) {
  if (!tab?.url) return false;

  try {
    const url = new URL(tab.url);
    return (
      url.pathname.endsWith(`/${MEDIA_PAGE}`) &&
      url.searchParams.get("window") === "1"
    );
  } catch {
    return tab.url.includes(MEDIA_PAGE) && tab.url.includes(MEDIA_WINDOW_QUERY);
  }
}

function registerMediaWindow(windowId) {
  if (typeof windowId === "number") {
    mediaWindowIds.add(windowId);
  }
}

function unregisterMediaWindow(windowId) {
  mediaWindowIds.delete(windowId);
}

async function syncMediaWindowIds() {
  mediaWindowIds.clear();
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (win.tabs?.some(isMediaWindowTab)) {
      registerMediaWindow(win.id);
    }
  }
}

async function findMediaWindow() {
  await syncMediaWindowIds();
  const firstId = mediaWindowIds.values().next().value;
  if (firstId === undefined) return null;
  return chrome.windows.get(firstId, { populate: true });
}

async function readMediaWindowBounds() {
  const stored = await chrome.storage.local.get(MEDIA_WINDOW_BOUNDS_KEY);
  return stored[MEDIA_WINDOW_BOUNDS_KEY] || { ...DEFAULT_MEDIA_WINDOW_BOUNDS };
}

async function persistMediaWindowBounds(bounds) {
  if (!bounds?.width || !bounds?.height) return;

  const payload = {
    width: bounds.width,
    height: bounds.height,
  };

  if (typeof bounds.left === "number") payload.left = bounds.left;
  if (typeof bounds.top === "number") payload.top = bounds.top;
  if (bounds.state) payload.state = bounds.state;

  await chrome.storage.local.set({ [MEDIA_WINDOW_BOUNDS_KEY]: payload });
}

async function saveMediaWindowBoundsById(windowId) {
  try {
    const win = await chrome.windows.get(windowId);
    if (!mediaWindowIds.has(windowId)) {
      const full = await chrome.windows.get(windowId, { populate: true });
      if (!full.tabs?.some(isMediaWindowTab)) return;
      registerMediaWindow(windowId);
    }

    await persistMediaWindowBounds({
      width: win.width,
      height: win.height,
      left: win.left,
      top: win.top,
      state: win.state,
    });
  } catch {
    unregisterMediaWindow(windowId);
  }
}

async function openMediaWindow() {
  const existing = await findMediaWindow();
  if (existing?.id) {
    await chrome.windows.update(existing.id, { focused: true });
    return;
  }

  const bounds = await readMediaWindowBounds();
  const createData = {
    url: getMediaWindowUrl(),
    type: "popup",
    width: bounds.width || DEFAULT_MEDIA_WINDOW_BOUNDS.width,
    height: bounds.height || DEFAULT_MEDIA_WINDOW_BOUNDS.height,
    focused: true,
  };

  if (typeof bounds.left === "number") createData.left = bounds.left;
  if (typeof bounds.top === "number") createData.top = bounds.top;
  if (bounds.state && bounds.state !== "minimized") createData.state = bounds.state;

  const win = await chrome.windows.create(createData);
  registerMediaWindow(win.id);
}

async function getMediaTabs(refresh = true) {
  await cacheReady;

  const tabs = await chrome.tabs.query({});
  tabs.sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });

  const ordered = tabs.filter(isTrackableTab);
  pruneStaleCache(ordered);

  function buildResult() {
    const items = [];
    for (const tab of ordered) {
      const state = tabStates.get(tab.id);
      const item = buildMediaTabItem(tab, state);
      if (item) items.push(item);
    }
    return items;
  }

  if (!refresh) {
    return buildResult();
  }

  const missing = ordered.filter(
    (tab) =>
      !isUnloaded(tab) &&
      !tabStates.has(tab.id) &&
      (tab.audible || isLikelyMediaTab(tab))
  );

  if (missing.length > 0) {
    const missingResults = await runPool(missing, (tab) => refreshTabState(tab), 4);
    const interactions = [];
    for (let i = 0; i < missing.length; i++) {
      const state = missingResults[i];
      if (state?.__interaction) {
        interactions.push({ tabId: missing[i].id, kind: state.__interaction });
      }
    }
    await noteDetectedInteractions(interactions);
  }

  let result = buildResult();

  if (result.length === 0) {
    await discoverMediaTabs(ordered);
    result = buildResult();
  }

  const tabById = new Map(ordered.map((tab) => [tab.id, tab]));
  const toUpdate = result
    .map((item) => tabById.get(item.tabId))
    .filter((tab) => tab && !isUnloaded(tab));

  if (toUpdate.length > 0) {
    const updateResults = await runPool(toUpdate, (tab) => refreshTabState(tab), 4);
    const interactions = [];
    for (let i = 0; i < toUpdate.length; i++) {
      const state = updateResults[i];
      if (state?.__interaction) {
        interactions.push({ tabId: toUpdate[i].id, kind: state.__interaction });
      }
    }
    await noteDetectedInteractions(interactions);
    result = buildResult();
  }

  return result;
}

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: "Play / Pause last media tab",
        contexts: ["action"],
      },
      () => void chrome.runtime.lastError
    );
  });
}

let cacheReady = loadCache();
syncMediaWindowIds();

chrome.runtime.onStartup.addListener(() => {
  cacheReady = loadCache();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") {
    tabStates.clear();
    persistCache();
    chrome.storage.session.remove(STORAGE_KEY).catch(() => {});
  }
  cacheReady = loadCache();
  setupContextMenu();
  updateBadge();
});

setupContextMenu();

if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener((window) => {
    if (mediaWindowIds.has(window.id)) {
      saveMediaWindowBoundsById(window.id);
    }
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  unregisterMediaWindow(windowId);
});

async function resolveLastInteractionTabId() {
  await cacheReady;
  if (lastInteractionTabId == null) return null;
  try {
    await chrome.tabs.get(lastInteractionTabId);
    return lastInteractionTabId;
  } catch {
    lastInteractionTabId = null;
    chrome.storage.session.remove(LAST_INTERACTION_KEY).catch(() => {});
    return null;
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const tabId = await resolveLastInteractionTabId();
  if (tabId) await toggleTab(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_MEDIA_TABS") {
    getMediaTabs(message.refresh !== false).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_PLAY") {
    playTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_PAUSE") {
    pauseTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_MUTE") {
    setTabMuted(message.tabId, message.muted).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_VOLUME") {
    if (typeof message.volume === "number") {
      setTabVolume(message.tabId, message.volume).then(sendResponse);
    } else {
      getTabVolume(message.tabId).then(sendResponse);
    }
    return true;
  }
  if (message.type === "TAB_TOGGLE") {
    toggleTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_SEEK") {
    seekTab(message.tabId, { delta: message.delta, position: message.position }).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_LIKE") {
    likeTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "TAB_CLOSE") {
    closeMediaTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "ACTIVATE_TAB") {
    activateMediaTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "PAUSE_ALL") {
    pauseAllMediaTabs().then(sendResponse);
    return true;
  }
  if (message.type === "MUTE_ALL") {
    muteAllMediaTabs().then(sendResponse);
    return true;
  }
  if (message.type === "VOLUME_ALL") {
    setVolumeAllMediaTabs(message.volume).then(sendResponse);
    return true;
  }
  if (message.type === "OPEN_MEDIA_WINDOW") {
    openMediaWindow().then(sendResponse);
    return true;
  }
  if (message.type === "SAVE_MEDIA_WINDOW_BOUNDS") {
    const windowId = _sender.tab?.windowId;
    if (windowId) {
      saveMediaWindowBoundsById(windowId).then(sendResponse);
      return true;
    }
  }
  if (message.type === "RESIZE_MEDIA_WINDOW") {
    const windowId = _sender.tab?.windowId;
    if (!windowId || typeof message.height !== "number") {
      sendResponse({ ok: false });
      return true;
    }

    chrome.windows
      .get(windowId)
      .then(async (win) => {
        await chrome.windows.update(windowId, {
          width: win.width,
          height: Math.max(120, Math.round(message.height)),
        });
        await saveMediaWindowBoundsById(windowId);
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message.type === "TOGGLE_TAB" && message.tabId) {
    toggleTab(message.tabId).then(sendResponse);
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  persistCache();
  syncStatusPoll();
  if (lastInteractionTabId === tabId) {
    lastInteractionTabId = null;
    chrome.storage.session.remove(LAST_INTERACTION_KEY).catch(() => {});
  }
  updateBadge();
  notifyPopupDebounced();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.mutedInfo !== undefined) {
    notifyPopupDebounced();
  }

  if (!isTrackableTab(tab)) return;

  if (changeInfo.discarded === true) {
    const cached = tabStates.get(tabId);
    if (cached?.hasMedia && cached?.controllable) {
      storeTabState(tabId, { hasMedia: true, isPlaying: false }, tab);
    } else {
      tabStates.delete(tabId);
      persistCache();
    }
    updateBadge();
    notifyPopupDebounced();
    return;
  }

  if (
    changeInfo.audible === true ||
    changeInfo.status === "complete" ||
    changeInfo.audible === false
  ) {
    refreshTabState(tab).then(async (state) => {
      if (state?.__interaction) {
        await noteDetectedInteractions([{ tabId, kind: state.__interaction }]);
      }
      updateBadge();
      notifyPopupDebounced();
    });
  }
});
