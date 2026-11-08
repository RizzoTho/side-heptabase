// Content-script quick capture. Tokens and draft storage remain in the background service worker.
(() => {
  if (document.getElementById("side-heptabase-root")) return;
  const hiddenUntilRefresh = document.documentElement.dataset.sideHeptabaseHiddenUntilRefresh === "true";
  delete document.documentElement.dataset.sideHeptabaseHiddenUntilRefresh;

  const MODES = {
    journal: { title: "Journal", icon: "calendar", placeholder: "Add to today's Journal…" },
    todo: { title: "Todo", icon: "check-circle", placeholder: "Add a to-do to today's Journal…" },
    note: { title: "Note", icon: "document-text", placeholder: "Write a note…" },
    link: { title: "Link", icon: "link3", placeholder: "Add a note to this link…" },
  };
  const CHECK_ICON = '<svg class="check-line" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';
  const CLOSE_ICON = '<svg class="close-line" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const icons = window.reicon;
  if (!icons?.["meta-custom"] || !icons?.["circle-arrow-up"]) throw new Error("Floating capture icons are missing");
  const markdownEditorReady = import(chrome.runtime.getURL("sidepanel/md-editor.js"));

  const host = document.createElement("div");
  host.id = "side-heptabase-root";
  host.style.visibility = "hidden";
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("floating/floating.css");
  stylesheet.addEventListener("load", () => { host.style.visibility = "visible"; });
  stylesheet.addEventListener("error", () => { console.error("[capture] stylesheet failed to load"); });
  shadow.append(stylesheet);

  const capture = document.createElement("div");
  capture.className = "capture";
  capture.innerHTML = `
    <section class="sheet glass" role="dialog" aria-label="Quick capture">
      <div class="sheet-head"><span class="sheet-icon"></span><span class="sheet-title">Journal</span></div>
      <div class="link-chip" hidden><span>${icons.link3}</span><span class="link-text"><strong></strong><small></small></span></div>
      <textarea rows="4" aria-label="Capture content" autocomplete="off" hidden></textarea>
      <div class="editor-slot"><slot name="capture-editor"></slot></div>
      <div class="sheet-foot"><span class="status" role="status" aria-live="polite"></span><button class="restore" type="button" hidden>Restore draft</button><button class="send" type="button" data-state="idle" disabled><span class="send-text">Add</span><span class="send-icon">${icons["circle-arrow-up"]}</span></button></div>
    </section>
    <div class="dock glass" role="group" aria-label="Quick capture">
      <button class="action" data-mode="journal" type="button" aria-label="Journal" title="Journal"><span>${icons.calendar}</span></button>
      <button class="action" data-mode="todo" type="button" aria-label="Todo" title="Todo"><span>${icons["check-circle"]}</span></button>
      <button class="action" data-mode="note" type="button" aria-label="Note" title="Note"><span>${icons["document-text"]}</span></button>
      <button class="action" data-mode="link" type="button" aria-label="Link" title="Link"><span>${icons.link3}</span></button>
    </div>
    <div class="utility-shell glass" role="group" aria-label="Side Heptabase">
      <button class="action meta" type="button" aria-label="Open side panel" aria-expanded="false" title="Open side panel"><span>${icons["meta-custom"]}</span></button>
      <button class="action settings" type="button" aria-label="Settings" aria-expanded="false" title="Settings"><span>${icons.settings}</span></button>
    </div>
    <button class="dismiss" type="button" aria-label="Hide floating capture until refresh" title="Hide until refresh">${CLOSE_ICON}</button>
    <section class="settings-panel glass" aria-label="Settings">
      <h2>Settings</h2>
      <div class="connection-row"><span>MCP connection</span><span class="connection-state" data-state="checking">Checking</span></div>
      <span class="settings-label">Meta click</span>
      <div class="shortcut-options" role="radiogroup" aria-label="Meta click action">
        <label class="shortcut-option"><span>${icons["document-text"]}</span><span>Open side panel</span><input type="radio" name="meta-action" value="side-panel"></label>
        <label class="shortcut-option"><span>${icons.calendar}</span><span>Reopen last capture</span><input type="radio" name="meta-action" value="last-capture"></label>
      </div>
      <span class="settings-label">Appearance</span><button class="appearance" type="button">Light</button>
    </section>`;
  shadow.append(capture);
  const richInput = document.createElement("div");
  richInput.id = "side-heptabase-capture-editor";
  richInput.slot = "capture-editor";
  richInput.setAttribute("role", "textbox");
  richInput.setAttribute("aria-label", "Journal content");
  richInput.setAttribute("aria-multiline", "true");
  richInput.dataset.placeholder = "Write in Markdown…";
  richInput.dataset.empty = "true";
  richInput.contentEditable = "true";
  richInput.spellcheck = false;
  host.append(richInput);
  document.documentElement.append(host);

  const $ = (selector) => shadow.querySelector(selector);
  const sheet = $(".sheet");
  const dock = $(".dock");
  const utilityShell = $(".utility-shell");
  const meta = $(".meta");
  const settings = $(".settings");
  const dismiss = $(".dismiss");
  const settingsPanel = $(".settings-panel");
  const input = $("textarea");
  const sendButton = $(".send");
  const status = $(".status");
  const restoreButton = $(".restore");
  const connectionState = $(".connection-state");
  const appearanceButton = $(".appearance");
  const actionButtons = [...shadow.querySelectorAll(".dock .action")];
  const metaOptions = [...shadow.querySelectorAll('input[name="meta-action"]')];

  const state = {
    ready: false,
    hidden: hiddenUntilRefresh,
    pinned: false,
    transientOpen: false,
    sheetOpen: false,
    settingsOpen: false,
    mode: "journal",
    drafts: {},
    candidates: {},
    metaAction: "side-panel",
    appearance: "light",
    lastSent: null,
    connection: "checking",
    visual: "idle",
    visualMode: null,
    status: "",
    statusMode: null,
    statusTone: "",
    safeTravel: null,
    safeTimer: null,
    lastPointer: null,
    renderedMode: null,
  };
  let saveTail = Promise.resolve();
  let statusTimer = null;
  let sentTimer = null;
  let markdownEditor;
  let richComposition;

  function focusInput() {
    richInput.focus();
  }

  function syncRichInput() {
    const text = markdownEditor.getValue(richInput);
    richInput.dataset.empty = String(text === "");
    input.value = text;
    input.dispatchEvent(new Event("input"));
  }

  function currentSource() {
    return { title: document.title || location.href, url: /^https?:$/.test(location.protocol) ? location.href : "" };
  }

  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function draftFor(mode) {
    if (!state.drafts[mode]) {
      const source = currentSource();
      state.drafts[mode] = { id: null, revision: 0, mode, text: "", sourceTitle: source.title, sourceUrl: source.url, journalDate: today(), delivery: "idle", error: null };
    }
    return state.drafts[mode];
  }

  function isOpen() { return !state.hidden && (state.pinned || state.transientOpen); }
  function setStatus(message, tone = "", mode = state.mode, timeout = 0) {
    clearTimeout(statusTimer);
    state.status = message;
    state.statusMode = mode;
    state.statusTone = tone;
    renderStatus();
    if (timeout) statusTimer = setTimeout(() => {
      if (state.statusMode === mode && state.status === message) { state.status = ""; renderStatus(); }
    }, timeout);
  }

  function renderStatus() {
    const draft = state.drafts[state.mode];
    const explicit = state.statusMode === state.mode ? state.status : "";
    status.textContent = explicit || (draft?.delivery === "uncertain" ? "Delivery unclear · check Heptabase" : draft?.delivery === "auth" ? "Sign-in required · draft saved" : draft?.delivery === "error" ? draft.error || "Could not send" : "");
    status.dataset.tone = explicit ? state.statusTone : draft?.delivery === "auth" || draft?.delivery === "uncertain" || draft?.delivery === "error" ? "error" : "";
  }

  function render() {
    if (!state.ready) return;
    const open = isOpen();
    const draft = state.drafts[state.mode];
    capture.dataset.hidden = String(state.hidden);
    capture.dataset.open = String(open);
    capture.dataset.sheet = String(open && state.sheetOpen);
    capture.dataset.settings = String(open && state.settingsOpen);
    meta.setAttribute("aria-expanded", String(open));
    meta.setAttribute("aria-label", state.metaAction === "last-capture" ? "Reopen last capture" : "Open side panel");
    meta.title = state.metaAction === "last-capture" ? "Reopen last capture" : "Open side panel";
    settings.setAttribute("aria-expanded", String(open && state.settingsOpen));
    for (const button of actionButtons) {
      button.dataset.preview = String(open && state.sheetOpen && button.dataset.mode === state.mode);
      button.setAttribute("aria-pressed", String(state.pinned && button.dataset.mode === state.mode));
      button.disabled = state.visual === "sending" || state.visual === "reconnecting";
    }
    $(".sheet-title").textContent = MODES[state.mode].title;
    $(".sheet-icon").innerHTML = icons[MODES[state.mode].icon];
    richInput.dataset.placeholder = MODES[state.mode].placeholder;
    richInput.setAttribute("aria-label", `${MODES[state.mode].title} content`);
    if (state.renderedMode !== state.mode) {
      input.value = draft?.text || "";
      markdownEditor.setValue(richInput, input.value);
      richInput.dataset.empty = String(input.value === "");
      state.renderedMode = state.mode;
    }
    const linkChip = $(".link-chip");
    linkChip.hidden = state.mode !== "link";
    if (state.mode === "link") {
      const source = draft || draftFor("link");
      linkChip.querySelector("strong").textContent = source.sourceTitle || source.sourceUrl;
      linkChip.querySelector("small").textContent = source.sourceUrl ? new URL(source.sourceUrl).host + new URL(source.sourceUrl).pathname : "No page link";
    }
    restoreButton.hidden = Boolean(draft?.id) || !state.candidates[state.mode];
    const delivery = draft?.delivery || "idle";
    const visual = state.visualMode === state.mode && state.visual !== "idle" ? state.visual : delivery;
    sendButton.dataset.state = visual;
    $(".send-text").textContent = visual === "sending" ? "Adding" : visual === "sent" ? "Sent" : visual === "auth" ? "Reconnect" : visual === "reconnecting" ? "Connecting" : visual === "uncertain" ? "Retry" : "Add";
    $(".send-icon").innerHTML = visual === "sent" ? CHECK_ICON : ["sending", "reconnecting"].includes(visual) ? "" : icons["circle-arrow-up"];
    sendButton.disabled = ["sending", "reconnecting", "sent"].includes(visual)
      || (!["auth", "uncertain"].includes(visual) && state.mode !== "link" && !input.value.trim())
      || (state.mode === "link" && !draft?.sourceUrl);
    for (const option of metaOptions) option.checked = option.value === state.metaAction;
    host.dataset.theme = state.appearance;
    appearanceButton.textContent = state.appearance === "dark" ? "Dark" : "Light";
    connectionState.dataset.state = state.connection;
    connectionState.textContent = ({ checking: "Checking", connected: "Connected", auth: "Sign-in required", unavailable: "Unavailable", "read-only": "Read-only" })[state.connection];
    renderStatus();
  }

  async function message(payload) {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response) throw new Error("Extension background did not respond");
    return response;
  }

  async function requireMessage(payload) {
    const response = await message(payload);
    if (!response.ok) throw new Error(response.error || "Extension action failed");
    return response.data;
  }

  function queueSave(mode) {
    const draft = draftFor(mode);
    const snapshot = { mode, id: draft.id, text: draft.text, sourceTitle: draft.sourceTitle, sourceUrl: draft.sourceUrl, journalDate: draft.journalDate };
    const operation = saveTail.catch(() => {}).then(async () => {
      const saved = await requireMessage({ action: "captureSave", draft: snapshot });
      const live = state.drafts[mode] || { ...snapshot };
      state.drafts[mode] = live;
      live.id = saved.id;
      live.revision = saved.revision;
      live.delivery = saved.delivery;
      live.error = saved.error;
      state.candidates[mode] = null;
      if (live.text === snapshot.text) setStatus("Draft saved", "ok", mode, 1000);
      render();
      return saved;
    });
    saveTail = operation;
    operation.catch((error) => {
      console.error("[capture] draft save failed", { mode, error: error.message });
      setStatus(`Draft not saved: ${error.message}`, "error", mode);
    });
    return operation;
  }

  async function flush(mode) {
    await queueSave(mode);
    let queued;
    do { queued = saveTail; await queued; } while (saveTail !== queued);
    return { ...draftFor(mode) };
  }

  function clearSafeTravel() {
    state.safeTravel = null;
    clearTimeout(state.safeTimer);
    state.safeTimer = null;
  }

  function collapseTransient() {
    clearSafeTravel();
    if (state.pinned) return;
    if (state.transientOpen) console.debug("[capture] hover collapsed", { mode: state.mode });
    state.transientOpen = false;
    state.settingsOpen = false;
    state.sheetOpen = false;
    render();
  }

  function collapseAll() {
    state.pinned = false;
    state.sheetOpen = false;
    state.transientOpen = false;
    state.settingsOpen = false;
    clearSafeTravel();
    render();
  }

  function hideUntilRefresh() {
    state.hidden = true;
    state.pinned = false;
    state.sheetOpen = false;
    state.transientOpen = false;
    state.settingsOpen = false;
    clearSafeTravel();
    render();
  }

  function inRect(point, rect) {
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }

  function visibleTargets() {
    if (state.hidden) return [];
    if (!isOpen()) return [utilityShell];
    return [utilityShell, dock, dismiss, ...(state.sheetOpen ? [sheet] : []), ...(state.settingsOpen ? [settingsPanel] : [])];
  }

  function hotAt(point) { return visibleTargets().some((element) => inRect(point, element.getBoundingClientRect())); }
  function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  function inTriangle(point, a, b, c) {
    const first = cross(a, b, point), second = cross(b, c, point), third = cross(c, a, point);
    return !(first < 0 || second < 0 || third < 0) || !(first > 0 || second > 0 || third > 0);
  }
  function targetEdge(apex, rect) {
    const centerX = (rect.left + rect.right) / 2, centerY = (rect.top + rect.bottom) / 2;
    const dx = centerX - apex.x, dy = centerY - apex.y, margin = 7;
    if (Math.abs(dx) > Math.abs(dy)) {
      const x = dx < 0 ? rect.right : rect.left;
      return [{ x, y: rect.top - margin }, { x, y: rect.bottom + margin }];
    }
    const y = dy < 0 ? rect.bottom : rect.top;
    return [{ x: rect.left - margin, y }, { x: rect.right + margin, y }];
  }
  function inSafeTriangle(point) {
    if (!state.safeTravel || performance.now() - state.safeTravel.started > 700) return false;
    return state.safeTravel.targets.some((target) => {
      const [first, second] = targetEdge(state.safeTravel.apex, target.getBoundingClientRect());
      return inTriangle(point, state.safeTravel.apex, first, second);
    });
  }

  const routes = new Map([
    [utilityShell, [dock, settingsPanel, dismiss, sheet]],
    [dock, [utilityShell, sheet, dismiss]],
    [sheet, [dock, utilityShell, dismiss]],
    [settingsPanel, [utilityShell, sheet]],
    [dismiss, [utilityShell, dock, sheet]],
  ]);
  for (const [element, targets] of routes) {
    element.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch" || state.hidden || !state.ready) return;
      clearSafeTravel();
      if (!isOpen()) {
        state.transientOpen = true;
        console.debug("[capture] hover opened", { mode: state.mode, target: element.className });
        render();
      }
    });
    element.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch" || state.pinned || !state.transientOpen) return;
      const apex = { x: event.clientX, y: event.clientY };
      clearSafeTravel();
      state.safeTravel = { apex, targets: targets.filter((target) => visibleTargets().includes(target)), started: performance.now() };
      state.safeTimer = setTimeout(() => {
        if (!state.pinned && state.safeTravel && !hotAt(state.lastPointer || apex)) collapseTransient();
      }, 700);
    });
  }

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" || state.hidden) return;
    state.lastPointer = { x: event.clientX, y: event.clientY };
    if (!state.transientOpen || state.pinned) return;
    if (hotAt(state.lastPointer)) { clearSafeTravel(); return; }
    if (inSafeTriangle(state.lastPointer)) return;
    collapseTransient();
  });
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch" || !state.transientOpen || state.pinned) return;
    const point = { x: event.clientX, y: event.clientY };
    state.lastPointer = point;
    if (!hotAt(point) && !inSafeTriangle(point)) collapseTransient();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!isOpen() || hotAt({ x: event.clientX, y: event.clientY })) return;
    console.info("[capture] dismissed by outside pointer", { mode: state.mode, wasPinned: state.pinned });
    collapseAll();
  }, true);

  function selectMode(mode, pin = false) {
    if (!MODES[mode] || state.hidden) return;
    draftFor(mode);
    state.mode = mode;
    state.sheetOpen = true;
    state.transientOpen = true;
    state.settingsOpen = false;
    if (pin) state.pinned = true;
    render();
    if (pin) focusInput();
  }

  for (const button of actionButtons) {
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch" && !state.pinned && !button.disabled) selectMode(button.dataset.mode);
    });
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode === "link") {
        const draft = draftFor(mode);
        if (!draft.id && !draft.text) {
          const source = currentSource();
          draft.sourceTitle = source.title;
          draft.sourceUrl = source.url;
        }
        if (draft.sourceUrl) {
          try {
            copyLink(draft.sourceUrl)
              .then(() => setStatus("Link copied", "ok", mode, 1200))
              .catch((error) => setStatus(`Copy unavailable: ${error.message}`, "error", mode));
          } catch (error) { setStatus(`Copy unavailable: ${error.message}`, "error", mode); }
        }
      }
      selectMode(mode, true);
      queueSave(mode);
    });
  }

  async function copyLink(url) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(url);
    const helper = document.createElement("textarea");
    helper.autocomplete = "off";
    helper.readOnly = true;
    helper.value = url;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.documentElement.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    if (!copied) throw new Error("Clipboard write was denied");
  }
  dock.addEventListener("pointerdown", (event) => { if (event.button === 0 && state.sheetOpen) state.pinned = true; });
  sheet.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    state.pinned = true;
    state.transientOpen = true;
    render();
  });

  meta.addEventListener("click", async () => {
    if (state.metaAction === "last-capture") {
      selectMode(state.lastSent?.mode || "journal", true);
      return;
    }
    const response = await message({ action: "captureOpenSidePanel" }).catch((error) => ({ ok: false, error: error.message }));
    if (!response.ok) {
      selectMode(state.mode);
      setStatus(`Could not open side panel: ${response.error}`, "error");
    }
  });
  dismiss.addEventListener("click", hideUntilRefresh);

  async function refreshConnection() {
    state.connection = "checking";
    render();
    const response = await message({ action: "captureConnectionStatus" }).catch((error) => ({ ok: false, error: error.message }));
    state.connection = response.ok ? response.data.state : "unavailable";
    if (!response.ok) console.error("[capture] connection check failed", { error: response.error });
    render();
  }
  settings.addEventListener("click", () => {
    state.transientOpen = true;
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen && !state.pinned) state.sheetOpen = false;
    render();
    if (state.settingsOpen) refreshConnection();
  });
  for (const option of metaOptions) {
    option.addEventListener("change", async () => {
      const previous = state.metaAction;
      state.metaAction = option.value;
      render();
      try { await requireMessage({ action: "captureSetMetaAction", metaAction: option.value }); }
      catch (error) { state.metaAction = previous; render(); setStatus(`Setting not saved: ${error.message}`, "error"); }
    });
  }
  appearanceButton.addEventListener("click", async () => {
    const previous = state.appearance;
    state.appearance = previous === "dark" ? "light" : "dark";
    render();
    try { await requireMessage({ action: "captureSetAppearance", appearance: state.appearance }); }
    catch (error) { state.appearance = previous; render(); setStatus(`Setting not saved: ${error.message}`, "error"); }
  });

  input.addEventListener("input", () => {
    const draft = draftFor(state.mode);
    draft.text = input.value;
    if (state.visual === "sent") { state.visual = "idle"; state.visualMode = null; }
    setStatus("Saving draft…", "", state.mode);
    queueSave(state.mode);
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendButton.click(); }
  });

  richInput.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  });
  richInput.addEventListener("keydown", (event) => {
    if (richComposition.isActive(event)) return;
    if (markdownEditor.handleCodeFenceKeys(richInput, event)) {
      markdownEditor.refreshStyles(richInput);
      syncRichInput();
      return;
    }
    if (markdownEditor.handleListEnter(richInput, event)) {
      markdownEditor.refreshStyles(richInput);
      syncRichInput();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendButton.click(); }
  });

  restoreButton.addEventListener("click", async () => {
    const mode = state.mode, candidate = state.candidates[mode];
    if (!candidate) return;
    restoreButton.disabled = true;
    try {
      const draft = await requireMessage({ action: "captureRestore", mode, candidateId: candidate.id });
      state.drafts[mode] = draft;
      state.candidates[mode] = null;
      state.renderedMode = null;
      state.pinned = true;
      render();
      focusInput();
      setStatus("Draft restored", "ok", mode, 1200);
    } catch (error) { setStatus(`Restore failed: ${error.message}`, "error", mode); }
    finally { restoreButton.disabled = false; }
  });

  sendButton.addEventListener("click", async () => {
    const mode = state.mode, draft = draftFor(mode);
    if (sendButton.disabled) return;
    if (draft.delivery === "auth") {
      state.visual = "reconnecting";
      state.visualMode = mode;
      setStatus("Draft kept during sign-in", "", mode);
      render();
      const response = await message({ action: "connect" }).catch((error) => ({ ok: false, error: error.message }));
      state.visual = "idle";
      state.visualMode = null;
      if (response.ok) {
        draft.delivery = "idle";
        draft.error = null;
        state.connection = "connected";
        setStatus("Draft ready", "ok", mode, 1500);
      } else setStatus(`Reconnect failed: ${response.error}`, "error", mode);
      render();
      return;
    }

    const retryUncertain = draft.delivery === "uncertain";
    state.visual = "sending";
    state.visualMode = mode;
    setStatus("", "", mode);
    render();
    let saved;
    try {
      saved = await flush(mode);
    } catch (error) {
      state.visual = "idle";
      state.visualMode = null;
      setStatus(`Draft not saved: ${error.message}`, "error", mode);
      render();
      return;
    }
    try {
      const response = await message({ action: "captureSubmit", mode, id: saved.id, revision: saved.revision, retryUncertain });
      if (!response.ok) {
        draft.delivery = response.deliveryState || "uncertain";
        draft.error = response.error;
        if (response.authRequired) state.connection = "auth";
        throw new Error(response.error || "Delivery was not confirmed");
      }
      state.lastSent = { mode };
      if (response.data.cleared) {
        const live = state.drafts[mode];
        if (live?.text === saved.text && live.revision === saved.revision) {
          state.drafts[mode] = null;
          input.value = "";
          markdownEditor.setValue(richInput, "");
          richInput.dataset.empty = "true";
        }
      } else if (response.data.draft && state.drafts[mode]?.text === response.data.draft.text) {
        state.drafts[mode] = response.data.draft;
      }
      state.visual = "sent";
      state.visualMode = mode;
      state.pinned = false;
      state.sheetOpen = true;
      state.transientOpen = true;
      setStatus("", "", mode);
      render();
      if (!state.lastPointer || !hotAt(state.lastPointer)) collapseTransient();
      clearTimeout(sentTimer);
      sentTimer = setTimeout(() => { state.visual = "idle"; state.visualMode = null; render(); }, 1700);
    } catch (error) {
      state.visual = "idle";
      state.visualMode = null;
      if (!["auth", "error"].includes(draft.delivery)) draft.delivery = "uncertain";
      setStatus(draft.delivery === "auth" ? "Sign-in required · draft saved" : draft.delivery === "error" ? `Could not send: ${error.message}` : `Delivery unclear: ${error.message}`, "error", mode);
      render();
      console.error("[capture] send failed", { mode, error: error.message });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    if (state.settingsOpen) { state.settingsOpen = false; render(); return; }
    collapseAll();
    meta.focus();
  });
  window.addEventListener("blur", () => { state.transientOpen = false; state.settingsOpen = false; clearSafeTravel(); render(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { state.transientOpen = false; state.settingsOpen = false; clearSafeTravel(); render(); } });

  (async () => {
    try {
      markdownEditor = await markdownEditorReady;
      richComposition = markdownEditor.bindEditorLifecycle(richInput, syncRichInput);
      const initial = await requireMessage({ action: "captureState" });
      state.drafts = initial.drafts || {};
      state.candidates = initial.candidates || {};
      state.metaAction = initial.metaAction;
      state.appearance = initial.appearance;
      state.lastSent = initial.lastSent;
      state.ready = true;
      render();
      console.info("[capture] ready", { recoveredModes: Object.keys(state.drafts).filter((mode) => state.drafts[mode]), candidateModes: Object.keys(state.candidates) });
    } catch (error) {
      console.error("[capture] initialization failed", { error: error.message });
      host.style.visibility = "visible";
      capture.innerHTML = `<div class="glass" style="position:absolute;right:0;width:210px;padding:12px;border-radius:14px;color:#b24943;font:12px sans-serif">Side Heptabase: ${String(error.message).replace(/[<>&]/g, "")}</div>`;
    }
  })();
})();
