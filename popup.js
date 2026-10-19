const tabList = document.getElementById("tab-list");
const emptyState = document.getElementById("empty");
const headerActions = document.getElementById("header-actions");
const pauseAllButton = document.getElementById("pause-all");
const muteAllButton = document.getElementById("mute-all");
const openWindowButton = document.getElementById("open-window");
const donateButton = document.getElementById("donate");
const KOFI_URL = "https://ko-fi.com/andrfil";
const isWindowMode = new URLSearchParams(location.search).get("window") === "1";

let renderTimer = null;
let renderInFlight = false;
const volumeDragTabIds = new Set();
let volumeSetTimer = null;
let pendingVolumeUpdate = null;
let bulkVolumeDragging = false;
let bulkVolumeSetTimer = null;
let pendingBulkVolume = null;
const bulkMuteWrap = document.querySelector(".bulk-mute-wrap");
const bulkVolumeSlider = document.getElementById("mute-all-volume");
const tabContextMenu = document.getElementById("tab-context-menu");
let contextMenuTabId = null;
let lastTabCount = 0;
const tabScroller = document.querySelector(".tab-scroller");

const POPUP_LIST_MAX_HEIGHT = 420;
const WINDOW_MAX_HEIGHT = 860;
const MIN_POPUP_HEIGHT = 96;

function measureHeaderHeight() {
  const leading = document.querySelector(".header-leading");
  if (!leading) return 0;

  const leadingHeight = leading.getBoundingClientRect().height;
  const actionsHeight =
    headerActions && !headerActions.hidden ? headerActions.getBoundingClientRect().height : 0;
  return Math.ceil(Math.max(leadingHeight, actionsHeight));
}

function measureListContentHeight() {
  if (tabScroller) {
    return Math.ceil(tabScroller.scrollHeight);
  }

  let height = 0;
  for (const track of tabList.querySelectorAll(".tab-track")) {
    height += track.getBoundingClientRect().height;
  }
  return Math.ceil(height);
}

function measureContentHeight() {
  const headerHeight = measureHeaderHeight();

  if (!emptyState.hidden) {
    return headerHeight + Math.ceil(emptyState.getBoundingClientRect().height);
  }

  return headerHeight + measureListContentHeight();
}

function applyPopupLayout(totalHeight) {
  const headerHeight = measureHeaderHeight();
  const listHeight = Math.max(0, totalHeight - headerHeight);
  const listCap = isWindowMode ? listHeight : Math.min(POPUP_LIST_MAX_HEIGHT, listHeight);

  document.documentElement.style.height = `${totalHeight}px`;
  document.body.style.height = `${totalHeight}px`;
  document.body.style.overflow = "hidden";
  document.body.classList.add("is-fitted");

  if (tabScroller) {
    tabScroller.style.height = listCap ? `${listCap}px` : "";
    tabScroller.style.maxHeight = listCap ? `${listCap}px` : "";
  }
}

async function fitPopupToContent() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const contentHeight = measureContentHeight();
  const maxHeight = isWindowMode
    ? WINDOW_MAX_HEIGHT
    : POPUP_LIST_MAX_HEIGHT + measureHeaderHeight();
  const totalHeight = Math.min(maxHeight, Math.max(MIN_POPUP_HEIGHT, contentHeight));

  applyPopupLayout(totalHeight);
  syncControlsColumn();

  if (!isWindowMode) return;

  chrome.runtime.sendMessage({ type: "RESIZE_MEDIA_WINDOW", height: totalHeight }, () => {
    void chrome.runtime.lastError;
  });
}

function syncControlsColumn() {
  const rowControls = tabList.querySelector(".tab-row .controls.controls-strip");
  if (!rowControls) {
    document.documentElement.style.removeProperty("--controls-col-width");
    document.documentElement.style.removeProperty("--scrollbar-width");
    return;
  }

  const width = Math.ceil(rowControls.getBoundingClientRect().width);
  document.documentElement.style.setProperty("--controls-col-width", `${width}px`);

  let scrollbarWidth = 0;
  if (tabScroller) {
    scrollbarWidth = Math.max(0, tabScroller.offsetWidth - tabScroller.clientWidth);
  }
  document.documentElement.style.setProperty("--scrollbar-width", `${scrollbarWidth}px`);
}

function scheduleControlsColumnSync() {
  requestAnimationFrame(() => {
    syncControlsColumn();
  });
}

donateButton?.addEventListener("click", () => {
  chrome.tabs.create({ url: KOFI_URL });
  if (!isWindowMode) window.close();
});

if (isWindowMode) {
  document.body.classList.add("is-window");
  openWindowButton?.remove();

  function requestBoundsSave() {
    chrome.runtime.sendMessage({ type: "SAVE_MEDIA_WINDOW_BOUNDS" }, () => {
      void chrome.runtime.lastError;
    });
  }

  window.addEventListener("pagehide", requestBoundsSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") requestBoundsSave();
  });
  window.addEventListener("resize", requestBoundsSave);
} else {
  openWindowButton?.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "OPEN_MEDIA_WINDOW" });
    window.close();
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchTabs(refresh) {
  try {
    return await chrome.runtime.sendMessage({ type: "GET_MEDIA_TABS", refresh });
  } catch {
    return [];
  }
}

function isTabPlaying(tab) {
  return !tab.unloaded && tab.isPlaying;
}

function muteButtonContent(muted) {
  if (muted) {
    return '<span class="mute-glyph" aria-hidden="true">🔇</span>';
  }
  return "🔊";
}

function displayVolume(tab) {
  if (tab.muted) return 0;
  if (typeof tab.volume === "number" && Number.isFinite(tab.volume)) {
    return Math.min(1, Math.max(0, tab.volume));
  }
  return 1;
}

function volumeSliderTooltipHtml(value = 0) {
  return `<span class="volume-slider-tooltip" hidden>${Math.round(value)}%</span>`;
}

function updateVolumeTooltip(slider, { visible = true } = {}) {
  if (!slider) return;

  const popover = slider.closest(".volume-popover");
  if (!popover) return;

  let tooltip = popover.querySelector(".volume-slider-tooltip");
  if (!tooltip) {
    popover.insertAdjacentHTML("afterbegin", volumeSliderTooltipHtml(slider.value));
    tooltip = popover.querySelector(".volume-slider-tooltip");
  }

  const value = Math.round(Number(slider.value));
  tooltip.textContent = `${value}%`;

  const ratio = Math.min(1, Math.max(0, value / 100));
  tooltip.style.left = `${ratio * slider.clientWidth}px`;
  tooltip.hidden = !visible;
}

function setupVolumeSlider(slider) {
  if (!slider || slider.dataset.tooltipBound === "1") return;
  slider.dataset.tooltipBound = "1";

  const showTooltip = () => updateVolumeTooltip(slider, { visible: true });
  const hideTooltip = () => {
    if (slider.matches(":active")) return;
    updateVolumeTooltip(slider, { visible: false });
  };

  slider.addEventListener("input", showTooltip);
  slider.addEventListener("pointerdown", showTooltip);
  slider.addEventListener("pointerup", () => {
    setTimeout(hideTooltip, 300);
  });
  slider.addEventListener("mouseenter", showTooltip);
  slider.addEventListener("mousemove", showTooltip);
  slider.addEventListener("mouseleave", hideTooltip);
}

function closeVolumePopover(wrap) {
  if (!wrap) return;

  wrap.classList.remove("is-volume-open");
  const active = document.activeElement;
  if (active && wrap.contains(active)) {
    active.blur();
  }

  const slider = wrap.querySelector(".volume-slider");
  if (slider) {
    updateVolumeTooltip(slider, { visible: false });
  }
}

function muteButtonHtml(tab) {
  const muteClass = tab.muted ? "mute is-muted" : "mute";
  const muteTitle = tab.muted ? "Unmute" : "Mute";
  const sliderValue = Math.round(displayVolume(tab) * 100);
  return (
    `<div class="mute-wrap">` +
    `<button class="${muteClass}" data-tab-id="${tab.tabId}" data-muted="${tab.muted}" type="button" title="${muteTitle}">` +
    `${muteButtonContent(tab.muted)}</button>` +
    `<div class="volume-popover" role="group" aria-label="Volume">` +
    volumeSliderTooltipHtml(sliderValue) +
    `<input class="volume-slider" data-tab-id="${tab.tabId}" type="range" min="0" max="100" step="1" value="${sliderValue}" aria-label="Volume">` +
    `</div></div>`
  );
}

function readRowProgress(row) {
  const track = row.querySelector(".tab-track");
  const raw = track?.style.getPropertyValue("--progress")?.trim();
  if (!raw) return 0;

  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function getRowTabState(row) {
  const tabId = Number(row.dataset.tabId);
  const toggleBtn = row.querySelector(".toggle-play");
  const muteBtn = row.querySelector(".mute");
  const slider = row.querySelector(".volume-slider");
  const muted = muteBtn?.dataset.muted === "true";
  const volumeFromSlider = slider ? Number(slider.value) / 100 : null;

  return {
    tabId,
    muted,
    isPlaying: Boolean(toggleBtn?.classList.contains("is-playing")),
    progress: readRowProgress(row),
    duration: normalizeDuration(Number(row.dataset.duration) || 0),
    volume: volumeFromSlider ?? (muted ? 0 : 1),
    unloaded: row.classList.contains("is-unloaded"),
  };
}

function applyOptimisticToggle(row) {
  const tab = getRowTabState(row);
  tab.isPlaying = !tab.isPlaying;
  tab.lastInteraction = true;
  updateTabRow(tab, row);
  markLocalLastInteraction(tab.tabId);
}

function applyOptimisticMute(row) {
  const tab = getRowTabState(row);
  tab.muted = !tab.muted;
  if (tab.muted) {
    tab.volume = 0;
  } else if (tab.volume <= 0) {
    tab.volume = 1;
  }
  tab.lastInteraction = true;
  updateTabRow(tab, row);
  markLocalLastInteraction(tab.tabId);
}

function applyOptimisticSeek(row, delta) {
  const tab = getRowTabState(row);
  const duration = tab.duration || getRowDuration(row, tab);
  if (duration > 0) {
    const nextTime = Math.min(Math.max(0, tab.progress * duration + delta), duration);
    tab.progress = nextTime / duration;
  }
  tab.lastInteraction = true;
  updateTabRow(tab, row);
  markLocalLastInteraction(tab.tabId);
}

function applyOptimisticVolume(row, volume) {
  const tab = getRowTabState(row);
  tab.volume = volume;
  tab.muted = volume <= 0;
  tab.lastInteraction = true;
  updateTabRow(tab, row);
  markLocalLastInteraction(tab.tabId);
}

function applyOptimisticPauseAll() {
  for (const row of tabList.querySelectorAll(".tab-row")) {
    if (row.classList.contains("is-unloaded")) continue;
    const tab = getRowTabState(row);
    tab.isPlaying = false;
    updateTabRow(tab, row);
  }
}

function applyOptimisticMuteAll() {
  const loadedRows = [...tabList.querySelectorAll(".tab-row")].filter(
    (row) => !row.classList.contains("is-unloaded")
  );
  const allMuted = loadedRows.length > 0 && loadedRows.every((row) => getRowTabState(row).muted);
  const targetMuted = !allMuted;
  const tabs = [];

  for (const row of loadedRows) {
    const tab = getRowTabState(row);
    tab.muted = targetMuted;
    if (targetMuted) {
      tab.volume = 0;
    } else if (tab.volume <= 0) {
      tab.volume = 1;
    }
    updateTabRow(tab, row);
    tabs.push(tab);
  }

  updateBulkMuteButton(tabs);
}

function applyOptimisticVolumeAll(volume) {
  for (const row of tabList.querySelectorAll(".tab-row")) {
    if (row.classList.contains("is-unloaded")) continue;
    applyOptimisticVolume(row, volume);
  }

  if (bulkVolumeSlider && !bulkVolumeSlider.matches(":active")) {
    bulkVolumeSlider.value = String(Math.round(volume * 100));
  }

  const tabs = [...tabList.querySelectorAll(".tab-row")]
    .filter((row) => !row.classList.contains("is-unloaded"))
    .map((row) => {
      const tab = getRowTabState(row);
      return { ...tab, volume, muted: volume <= 0 };
    });
  updateBulkMuteButton(tabs);
}

function syncFromServer(refresh = true) {
  void render({ refresh });
}

function computeBulkVolumePercent(tabs) {
  const loaded = tabs.filter((tab) => !tab.unloaded);
  if (loaded.length === 0) return 100;
  if (loaded.every((tab) => tab.muted)) return 0;

  const audible = loaded.filter((tab) => !tab.muted);
  const sum = audible.reduce((acc, tab) => acc + displayVolume(tab), 0);
  return Math.round((sum / audible.length) * 100);
}

function updateBulkMuteButton(tabs) {
  if (!muteAllButton) return;

  const loaded = tabs.filter((tab) => !tab.unloaded);
  const allMuted = loaded.length > 0 && loaded.every((tab) => tab.muted);
  muteAllButton.classList.toggle("is-active", allMuted);
  muteAllButton.title = allMuted ? "Unmute all" : "Mute all";

  if (bulkVolumeSlider && !bulkVolumeDragging && !bulkVolumeSlider.matches(":active")) {
    bulkVolumeSlider.value = String(computeBulkVolumePercent(tabs));
  }
}

function toggleButtonHtml(tab) {
  const playing = isTabPlaying(tab);
  const toggleClass = playing ? "toggle-play is-playing" : "toggle-play";
  const label = playing ? "⏸" : "▶";
  const title = playing ? "Pause" : "Play";
  return `<button class="${toggleClass}" data-tab-id="${tab.tabId}" type="button" title="${title}">${label}</button>`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function getRowDuration(row, tab) {
  const fromTab = normalizeDuration(tab?.duration);
  if (fromTab > 0) return fromTab;
  const fromDataset = Number(row?.dataset?.duration);
  return normalizeDuration(fromDataset);
}

function normalizeDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function updateProgress(row, tab) {
  const progress = typeof tab.progress === "number" ? tab.progress : 0;
  const track = row.querySelector(".tab-track");
  if (!track || track.classList.contains("is-seeking")) return;

  track.style.setProperty("--progress", String(progress));
  track.classList.toggle("has-progress", progress > 0);

  const duration = getRowDuration(row, tab);
  if (duration > 0) {
    row.dataset.duration = String(duration);
  } else {
    delete row.dataset.duration;
  }
}

function updateSeekTooltip(seekBar, event, duration) {
  const tooltip = seekBar.querySelector(".tab-seek-tooltip");
  if (!tooltip) return;

  if (!duration) {
    tooltip.hidden = true;
    return;
  }

  const rect = seekBar.getBoundingClientRect();
  if (rect.width <= 0) {
    tooltip.hidden = true;
    return;
  }

  const progress = progressFromSeekEvent(seekBar, event);
  const time = progress * duration;
  tooltip.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  tooltip.hidden = false;

  const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  tooltip.style.left = `${(x / rect.width) * 100}%`;
}

function hideSeekTooltip(seekBar) {
  const tooltip = seekBar.querySelector(".tab-seek-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function progressFromSeekEvent(seekBar, event) {
  const rect = seekBar.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function setupSeekBar(row) {
  const seekBar = row.querySelector(".tab-seek");
  const track = row.querySelector(".tab-track");
  if (!seekBar || !track || seekBar.dataset.bound === "1") return;

  seekBar.dataset.bound = "1";

  if (!seekBar.querySelector(".tab-seek-tooltip")) {
    seekBar.insertAdjacentHTML("beforeend", '<span class="tab-seek-tooltip" hidden></span>');
  }

  let dragging = false;

  function setLocalProgress(progress) {
    track.style.setProperty("--progress", String(progress));
    track.classList.toggle("has-progress", progress > 0);
  }

  function getDuration() {
    return getRowDuration(row);
  }

  async function commitSeek(position) {
    const tabId = Number(row.dataset.tabId);
    if (!tabId) return;

    try {
      const result = await chrome.runtime.sendMessage({
        type: "TAB_SEEK",
        tabId,
        position,
      });

      if (result?.tabId) {
        result.lastInteraction = true;
        updateTabRow(result, row);
        markLocalLastInteraction(tabId);
      } else {
        syncFromServer();
      }
    } catch {
      syncFromServer();
    } finally {
      track.classList.remove("is-seeking");
    }
  }

  seekBar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();

    dragging = true;
    track.classList.add("is-seeking");
    seekBar.classList.add("is-dragging");
    seekBar.setPointerCapture(event.pointerId);
    setLocalProgress(progressFromSeekEvent(seekBar, event));
    updateSeekTooltip(seekBar, event, getDuration());
    markLocalLastInteraction(Number(row.dataset.tabId));
  });

  seekBar.addEventListener("pointermove", (event) => {
    if (dragging) {
      setLocalProgress(progressFromSeekEvent(seekBar, event));
      updateSeekTooltip(seekBar, event, getDuration());
    }
  });

  seekBar.addEventListener("mousemove", (event) => {
    updateSeekTooltip(seekBar, event, getDuration());
  });

  seekBar.addEventListener("mouseleave", () => {
    hideSeekTooltip(seekBar);
  });

  function finishDrag(event) {
    if (!dragging) return;

    dragging = false;
    seekBar.classList.remove("is-dragging");
    hideSeekTooltip(seekBar);

    if (seekBar.hasPointerCapture(event.pointerId)) {
      seekBar.releasePointerCapture(event.pointerId);
    }

    commitSeek(progressFromSeekEvent(seekBar, event));
  }

  seekBar.addEventListener("pointerup", finishDrag);
  seekBar.addEventListener("pointercancel", finishDrag);
}

function updateVolumeSlider(row, tab, { force = false } = {}) {
  const slider = row.querySelector(".volume-slider");
  if (!slider) return;

  const tabId = String(tab.tabId);
  if (!force && (volumeDragTabIds.has(tabId) || slider.matches(":active"))) {
    return;
  }

  slider.value = String(Math.round(displayVolume(tab) * 100));
  updateVolumeTooltip(slider, {
    visible:
      slider.matches(":active") ||
      Boolean(slider.closest(".mute-wrap")?.classList.contains("is-volume-open")),
  });
}

function setupVolumeWrap(wrap, { onShow } = {}) {
  if (!wrap || wrap.dataset.volumeReady === "1") return;
  wrap.dataset.volumeReady = "1";

  let hideTimer = null;

  const show = () => {
    clearTimeout(hideTimer);
    wrap.classList.add("is-volume-open");
    onShow?.();
  };

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (wrap.dataset.volumeDragging !== "1") {
        closeVolumePopover(wrap);
      }
    }, 140);
  };

  wrap.addEventListener("mouseenter", show);
  wrap.addEventListener("mouseleave", scheduleHide);
  wrap.addEventListener("focusin", show);
  wrap.addEventListener("focusout", scheduleHide);
}

function setupMuteVolume(row) {
  const wrap = row.querySelector(".mute-wrap");
  if (!wrap) return;

  const slider = wrap.querySelector(".volume-slider");
  setupVolumeSlider(slider);

  const tabId = Number(row.dataset.tabId);
  setupVolumeWrap(wrap, {
    onShow: async () => {
      if (!tabId || row.classList.contains("is-unloaded")) return;

      try {
        const state = await chrome.runtime.sendMessage({ type: "TAB_VOLUME", tabId });
        if (!state?.ok || state.tabId !== tabId) return;

        if (!slider || volumeDragTabIds.has(String(tabId)) || slider.matches(":active")) return;

        const volume = state.muted ? 0 : (state.volume ?? 0);
        slider.value = String(Math.round(volume * 100));
        updateVolumeTooltip(slider, { visible: true });
      } catch {
        // Ignore refresh errors.
      }
    },
  });
}

function queueBulkVolumeUpdate(volume) {
  applyOptimisticVolumeAll(volume);
  pendingBulkVolume = volume;
  clearTimeout(bulkVolumeSetTimer);
  bulkVolumeSetTimer = setTimeout(flushBulkVolumeUpdate, 80);
}

async function flushBulkVolumeUpdate() {
  const volume = pendingBulkVolume;
  pendingBulkVolume = null;
  if (volume == null) return;

  try {
    await chrome.runtime.sendMessage({ type: "VOLUME_ALL", volume });
  } catch {
    syncFromServer();
    return;
  }
  syncFromServer();
}

function queueVolumeUpdate(tabId, volume) {
  const row = tabList.querySelector(`.tab-row[data-tab-id="${tabId}"]`);
  if (row) applyOptimisticVolume(row, volume);

  pendingVolumeUpdate = { tabId, volume };
  clearTimeout(volumeSetTimer);
  volumeSetTimer = setTimeout(flushVolumeUpdate, 80);
}

async function flushVolumeUpdate() {
  const pending = pendingVolumeUpdate;
  pendingVolumeUpdate = null;
  if (!pending) return;

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "TAB_VOLUME",
      tabId: pending.tabId,
      volume: pending.volume,
    });
  } catch {
    result = null;
  }

  if (result?.tabId) {
    const row = tabList.querySelector(`.tab-row[data-tab-id="${result.tabId}"]`);
    if (row) {
      updateTabRow(result, row);
      markLocalLastInteraction(result.tabId);
    }
  } else {
    syncFromServer();
  }
}

function createTabRow(tab) {
  const row = document.createElement("li");
  row.className = buildRowClass(tab);
  row.dataset.tabId = String(tab.tabId);
  row.dataset.windowId = String(tab.windowId);
  if (tab.workspaceId != null) {
    row.dataset.workspaceId = String(tab.workspaceId);
  }

  const favicon = tab.favIconUrl
    ? `<img class="favicon" src="${escapeHtml(tab.favIconUrl)}" alt="">`
    : `<span class="favicon"></span>`;

  const unloadedHint = tab.unloaded ? " (not loaded)" : "";

  row.innerHTML =
    `<div class="tab-track">` +
    `<div class="tab-progress"></div>` +
    `<div class="tab-seek"><div class="tab-seek-fill"></div><span class="tab-seek-tooltip" hidden></span></div>` +
    favicon +
    `<span class="title" title="${escapeHtml(tab.title + unloadedHint)}">${escapeHtml(tab.title)}${tab.unloaded ? '<span class="badge">💤</span>' : ""}</span>` +
    `</div>` +
    `<div class="controls controls-strip">` +
    `<button class="seek seek-back" data-tab-id="${tab.tabId}" data-delta="-5" type="button" title="−5 sec">−5</button>` +
    toggleButtonHtml(tab) +
    `<button class="seek seek-forward" data-tab-id="${tab.tabId}" data-delta="5" type="button" title="+5 sec">+5</button>` +
    muteButtonHtml(tab) +
    `</div>`;

  updateProgress(row, tab);
  setupSeekBar(row);
  setupMuteVolume(row);
  return row;
}

function buildRowClass(tab) {
  return (
    "tab-row" +
    (tab.unloaded ? " is-unloaded" : "") +
    (isTabPlaying(tab) ? " is-playing" : "") +
    (tab.lastInteraction ? " is-last-interaction" : "")
  );
}

function updateToggleButton(toggleBtn, tab) {
  const playing = isTabPlaying(tab);
  toggleBtn.className = playing ? "toggle-play is-playing" : "toggle-play";
  toggleBtn.textContent = playing ? "⏸" : "▶";
  toggleBtn.title = playing ? "Pause" : "Play";
}

function applyTabs(tabs) {
  const count = tabs?.length ?? 0;
  const shouldFitLayout = lastTabCount === 0 || count < lastTabCount;
  lastTabCount = count;

  if (!tabs || tabs.length === 0) {
    tabList.innerHTML = "";
    emptyState.hidden = false;
    if (headerActions) headerActions.hidden = true;
    if (shouldFitLayout) fitPopupToContent();
    return;
  }

  emptyState.hidden = true;
  if (headerActions) headerActions.hidden = false;
  updateBulkMuteButton(tabs);

  const nextIds = new Set(tabs.map((tab) => tab.tabId));

  for (const row of [...tabList.querySelectorAll(".tab-row")]) {
    if (!nextIds.has(Number(row.dataset.tabId))) {
      row.remove();
    }
  }

  for (const tab of tabs) {
    let row = tabList.querySelector(`.tab-row[data-tab-id="${tab.tabId}"]`);
    if (row) {
      updateTabRow(tab, row);
    } else {
      tabList.appendChild(createTabRow(tab));
    }
  }

  for (const row of tabList.querySelectorAll(".tab-row")) {
    setupMuteVolume(row);
  }

  if (shouldFitLayout) fitPopupToContent();
  else scheduleControlsColumnSync();
}

function updateTabRow(tab, row = null) {
  row = row || tabList.querySelector(`.tab-row[data-tab-id="${tab.tabId}"]`);
  if (!row) return false;

  row.className = buildRowClass(tab);
  updateProgress(row, tab);
  setupSeekBar(row);

  const titleEl = row.querySelector(".title");
  if (titleEl && tab.title) {
    const unloadedHint = tab.unloaded ? " (not loaded)" : "";
    titleEl.title = tab.title + unloadedHint;
    titleEl.innerHTML =
      escapeHtml(tab.title) + (tab.unloaded ? '<span class="badge">💤</span>' : "");
  }

  const faviconEl = row.querySelector(".favicon");
  if (faviconEl && tab.favIconUrl) {
    if (faviconEl.tagName === "IMG") {
      if (faviconEl.src !== tab.favIconUrl) faviconEl.src = tab.favIconUrl;
    } else {
      faviconEl.outerHTML = `<img class="favicon" src="${escapeHtml(tab.favIconUrl)}" alt="">`;
    }
  }

  const toggleBtn = row.querySelector(".toggle-play");
  const muteBtn = row.querySelector(".mute");

  if (toggleBtn) {
    updateToggleButton(toggleBtn, tab);
  }
  if (muteBtn) {
    muteBtn.dataset.muted = String(tab.muted);
    muteBtn.className = tab.muted ? "mute is-muted" : "mute";
    muteBtn.innerHTML = muteButtonContent(tab.muted);
    muteBtn.title = tab.muted ? "Unmute" : "Mute";
  }
  updateVolumeSlider(row, tab);

  return true;
}

function markLocalLastInteraction(tabId) {
  for (const row of tabList.querySelectorAll(".tab-row")) {
    row.classList.toggle("is-last-interaction", Number(row.dataset.tabId) === tabId);
  }
}

async function render({ refresh = false } = {}) {
  if (renderInFlight) {
    return;
  }

  renderInFlight = true;
  try {
    const tabs = await fetchTabs(refresh);
    applyTabs(tabs);
  } finally {
    renderInFlight = false;
  }
}

function scheduleRender(refresh = false, delay = 900) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render({ refresh });
  }, delay);
}

tabList.addEventListener(
  "click",
  async (event) => {
    const button = event.target.closest("button[data-tab-id]");
    if (!button || button.disabled) return;

    event.preventDefault();
    event.stopPropagation();

    const tabId = Number(button.dataset.tabId);
    const row = button.closest(".tab-row");
    if (!row) return;

    let messagePromise;
    if (button.classList.contains("toggle-play")) {
      applyOptimisticToggle(row);
      messagePromise = chrome.runtime.sendMessage({ type: "TAB_TOGGLE", tabId });
    } else if (button.classList.contains("seek")) {
      const delta = Number(button.dataset.delta);
      applyOptimisticSeek(row, delta);
      messagePromise = chrome.runtime.sendMessage({ type: "TAB_SEEK", tabId, delta });
    } else if (button.classList.contains("mute")) {
      closeVolumePopover(row.querySelector(".mute-wrap"));
      const muted = button.dataset.muted !== "true";
      applyOptimisticMute(row);
      messagePromise = chrome.runtime.sendMessage({ type: "TAB_MUTE", tabId, muted });
    } else {
      return;
    }

    try {
      const result = await messagePromise;
      if (result?.tabId) {
        result.lastInteraction = true;
        updateTabRow(result, row);
        markLocalLastInteraction(tabId);
      } else {
        syncFromServer();
      }
    } catch {
      syncFromServer();
    }
  },
  true
);

tabList.addEventListener(
  "input",
  (event) => {
    const slider = event.target.closest(".volume-slider");
    if (!slider || slider.disabled) return;

    event.stopPropagation();

    if (slider.classList.contains("bulk-volume-slider")) {
      queueBulkVolumeUpdate(Number(slider.value) / 100);
      return;
    }

    const tabId = Number(slider.dataset.tabId);
    if (!tabId) return;

    volumeDragTabIds.add(String(tabId));
    queueVolumeUpdate(tabId, Number(slider.value) / 100);
  },
  true
);

tabList.addEventListener(
  "pointerdown",
  (event) => {
    const slider = event.target.closest(".volume-slider");
    if (!slider) return;
    event.stopPropagation();

    if (slider.classList.contains("bulk-volume-slider")) {
      bulkVolumeDragging = true;
      slider.closest(".mute-wrap")?.setAttribute("data-volume-dragging", "1");
      return;
    }

    volumeDragTabIds.add(String(slider.dataset.tabId));
    slider.closest(".mute-wrap")?.setAttribute("data-volume-dragging", "1");
  },
  true
);

tabList.addEventListener(
  "pointerup",
  (event) => {
    const slider = event.target.closest(".volume-slider");
    if (!slider) return;
    event.stopPropagation();

    if (slider.classList.contains("bulk-volume-slider")) {
      bulkVolumeDragging = false;
      slider.closest(".mute-wrap")?.removeAttribute("data-volume-dragging");
      flushBulkVolumeUpdate();
      return;
    }

    volumeDragTabIds.delete(String(slider.dataset.tabId));
    slider.closest(".mute-wrap")?.removeAttribute("data-volume-dragging");
    flushVolumeUpdate();
  },
  true
);

tabList.addEventListener(
  "pointercancel",
  (event) => {
    const slider = event.target.closest(".volume-slider");
    if (!slider) return;

    if (slider.classList.contains("bulk-volume-slider")) {
      bulkVolumeDragging = false;
      slider.closest(".mute-wrap")?.removeAttribute("data-volume-dragging");
      return;
    }

    volumeDragTabIds.delete(String(slider.dataset.tabId));
    slider.closest(".mute-wrap")?.removeAttribute("data-volume-dragging");
  },
  true
);

tabList.addEventListener(
  "click",
  (event) => {
    if (event.target.closest(".volume-popover")) {
      event.stopPropagation();
    }
  },
  true
);

tabList.addEventListener("dblclick", async (event) => {
  if (
    event.target.closest("button") ||
    event.target.closest(".tab-seek") ||
    event.target.closest(".volume-popover")
  ) {
    return;
  }

  const row = event.target.closest(".tab-row");
  if (!row) return;

  const tabId = Number(row.dataset.tabId);
  if (!tabId) return;

  try {
    await chrome.runtime.sendMessage({ type: "ACTIVATE_TAB", tabId });
  } catch {
    const windowId = Number(row.dataset.windowId);
    await chrome.tabs.update(tabId, { active: true });
    if (windowId) {
      await chrome.windows.update(windowId, { focused: true });
    }
  }

  window.close();
});

function hideTabContextMenu() {
  if (!tabContextMenu) return;
  tabContextMenu.hidden = true;
  contextMenuTabId = null;
}

function showTabContextMenu(event, tabId) {
  if (!tabContextMenu) return;

  event.preventDefault();
  event.stopPropagation();

  contextMenuTabId = tabId;
  tabContextMenu.hidden = false;

  const menuRect = tabContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 4;
  const maxY = window.innerHeight - menuRect.height - 4;
  const x = Math.min(Math.max(event.clientX, 4), Math.max(4, maxX));
  const y = Math.min(Math.max(event.clientY, 4), Math.max(4, maxY));

  tabContextMenu.style.left = `${x}px`;
  tabContextMenu.style.top = `${y}px`;
}

function setupTabContextMenu() {
  if (!tabContextMenu) return;

  tabList.addEventListener("contextmenu", (event) => {
    if (event.target.closest("button") || event.target.closest(".volume-popover")) return;

    const row = event.target.closest(".tab-row");
    if (!row) {
      hideTabContextMenu();
      return;
    }

    const tabId = Number(row.dataset.tabId);
    if (!tabId) return;

    showTabContextMenu(event, tabId);
  });

  tabContextMenu.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || !contextMenuTabId) return;

    event.preventDefault();
    event.stopPropagation();

    const tabId = contextMenuTabId;
    const action = button.dataset.action;
    hideTabContextMenu();

    if (action === "like") {
      try {
        await chrome.runtime.sendMessage({ type: "TAB_LIKE", tabId });
      } catch {
        // Ignore like errors.
      }
      return;
    }

    if (action === "close") {
      const row = tabList.querySelector(`.tab-row[data-tab-id="${tabId}"]`);
      row?.remove();
      if (!tabList.querySelector(".tab-row")) {
        emptyState.hidden = false;
        if (headerActions) headerActions.hidden = true;
      }
      fitPopupToContent();

      try {
        await chrome.runtime.sendMessage({ type: "TAB_CLOSE", tabId });
      } catch {
        syncFromServer();
        return;
      }
      syncFromServer();
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".tab-context-menu")) return;
    hideTabContextMenu();
  });

  window.addEventListener("blur", hideTabContextMenu);
}

pauseAllButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  applyOptimisticPauseAll();
  try {
    await chrome.runtime.sendMessage({ type: "PAUSE_ALL" });
  } catch {
    syncFromServer();
    return;
  }
  syncFromServer();
});

muteAllButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeVolumePopover(bulkMuteWrap);
  applyOptimisticMuteAll();
  try {
    await chrome.runtime.sendMessage({ type: "MUTE_ALL" });
  } catch {
    syncFromServer();
    return;
  }
  syncFromServer();
});

if (bulkMuteWrap) {
  setupVolumeSlider(bulkVolumeSlider);
  setupVolumeWrap(bulkMuteWrap, {
    onShow: async () => {
      if (!bulkVolumeSlider || bulkVolumeDragging) return;
      try {
        const tabs = await fetchTabs(false);
        bulkVolumeSlider.value = String(computeBulkVolumePercent(tabs));
        updateVolumeTooltip(bulkVolumeSlider, { visible: true });
      } catch {
        // Ignore refresh errors.
      }
    },
  });
}

if (bulkVolumeSlider) {
  bulkVolumeSlider.addEventListener("input", (event) => {
    event.stopPropagation();
    queueBulkVolumeUpdate(Number(bulkVolumeSlider.value) / 100);
  });

  bulkVolumeSlider.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    bulkVolumeDragging = true;
    bulkMuteWrap?.setAttribute("data-volume-dragging", "1");
  });

  bulkVolumeSlider.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    bulkVolumeDragging = false;
    bulkMuteWrap?.removeAttribute("data-volume-dragging");
    flushBulkVolumeUpdate();
  });

  bulkVolumeSlider.addEventListener("pointercancel", () => {
    bulkVolumeDragging = false;
    bulkMuteWrap?.removeAttribute("data-volume-dragging");
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "MEDIA_STATE_CHANGED") {
    scheduleRender(true, 120);
  }
});

window.addEventListener("resize", scheduleControlsColumnSync);

render({ refresh: true });
setupTabContextMenu();
