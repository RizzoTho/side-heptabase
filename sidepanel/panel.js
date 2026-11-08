import { bindEditorLifecycle, refreshStyles, handleCodeFenceKeys, handleListEnter, getValue, setValue } from "./md-editor.js";

const editorView = document.getElementById("editor-view");
const connectView = document.getElementById("connect-view");
const editor = document.getElementById("editor");
const editorCard = document.getElementById("editor-card");
const sourceTitleEl = document.getElementById("source-title");
const sourceHostEl = document.getElementById("source-host");
const tabButtons = [...document.querySelectorAll("#tabs .tab")];
const saveBtn = document.getElementById("save-btn");
const saveLabel = saveBtn.querySelector(".save-label");
const saveGlyph = saveBtn.querySelector(".save-glyph");
const connectBtn = document.getElementById("connect-btn");
const statusEl = document.getElementById("status");
const connectStatusEl = document.getElementById("connect-status");
const icons = window.reicon;
if (!icons?.["document-text"] || !icons?.calendar || !icons?.link3 || !icons?.["circle-arrow-up"] || !icons?.["meta-custom"]) {
  throw new Error("Side panel icons are missing");
}
document.querySelector('.tab[data-target="card"] .tab-icon').innerHTML = icons["document-text"];
document.querySelector('.tab[data-target="journal"] .tab-icon').innerHTML = icons.calendar;
document.querySelector(".source-icon").innerHTML = icons.link3;
document.querySelector(".connect-icon").innerHTML = icons["meta-custom"];
const CHECK_ICON = '<svg class="check-line" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';

const DRAFT_KEY = "sidepanel:draft";
const TARGET_KEY = "sidepanel:target";
let currentTab = { title: "", url: "" };
let target = "card"; // "card" | "journal"
let editorRevision = 0;
let draftWrite = Promise.resolve();

function persistDraft(text) {
  const operation = draftWrite.catch(() => {}).then(() => chrome.storage.local.set({ [DRAFT_KEY]: text }));
  draftWrite = operation;
  operation.catch((error) => setStatus(statusEl, `Draft not saved: ${error.message}`, "error"));
  return operation;
}

function setSaveButtonState(state) {
  saveBtn.dataset.state = state;
  saveLabel.textContent = state === "sending" ? "Adding" : state === "sent" ? "Sent" : "Add";
  saveGlyph.innerHTML = state === "sending" ? "" : state === "sent" ? CHECK_ICON : icons["circle-arrow-up"];
  saveBtn.setAttribute("aria-busy", String(state === "sending"));
}
setSaveButtonState("idle");

// ---- view switching ----

function showView(connected) {
  editorView.hidden = !connected;
  connectView.hidden = connected;
}

// ---- current page tracking ----

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    currentTab = { title: tab?.title || "", url: "" };
  } else {
    currentTab = { title: tab.title || tab.url, url: tab.url };
  }
  sourceTitleEl.textContent = currentTab.title || "No page";
  sourceTitleEl.title = currentTab.url;
  sourceHostEl.textContent = currentTab.url ? new URL(currentTab.url).host : "";
}

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.url || info.status === "complete") refreshTab();
});

// ---- tabs (save target) ----

function setTarget(next) {
  target = next;
  for (const btn of tabButtons) {
    const active = btn.dataset.target === next;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  editorCard.classList.toggle("journal-active", next === "journal");
  chrome.storage.local.set({ [TARGET_KEY]: next }).catch((error) => setStatus(statusEl, `Preference not saved: ${error.message}`, "error"));
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => setTarget(btn.dataset.target));
}

// ---- editor ----

function editorText() {
  return getValue(editor);
}

function syncEditorState() {
  const text = editorText();
  editorRevision += 1;
  setSaveButtonState("idle");
  saveBtn.disabled = text.trim() === "";
  editor.dataset.empty = String(text === "");
  persistDraft(text);
}

const composition = bindEditorLifecycle(editor, syncEditorState);

// paste as plain text; execCommand keeps caret placement and undo history
editor.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData("text/plain");
  document.execCommand("insertText", false, text);
});

async function clearEditor() {
  await chrome.storage.session.remove("draft");
  draftWrite = draftWrite.catch(() => {}).then(() => chrome.storage.local.remove(DRAFT_KEY));
  await draftWrite;
  setValue(editor, "");
  editorRevision += 1;
  editor.dataset.empty = "true";
  saveBtn.disabled = true;
}

async function restoreSession() {
  const stored = await chrome.storage.local.get([DRAFT_KEY, TARGET_KEY]);
  const legacy = await chrome.storage.session.get(["draft", "target"]);
  const draft = stored[DRAFT_KEY] ?? legacy.draft;
  const savedTarget = stored[TARGET_KEY] ?? legacy.target;
  if (stored[DRAFT_KEY] === undefined && legacy.draft !== undefined) await chrome.storage.local.set({ [DRAFT_KEY]: legacy.draft });
  if (stored[TARGET_KEY] === undefined && legacy.target !== undefined) await chrome.storage.local.set({ [TARGET_KEY]: legacy.target });
  if (draft) {
    setValue(editor, draft);
    editor.dataset.empty = String(draft === "");
    saveBtn.disabled = draft.trim() === "";
  }
  if (savedTarget) setTarget(savedTarget);
}

// ---- messaging ----

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    // undefined = the service worker died before responding
    return res ?? { ok: false, error: "Background did not respond. Try again." };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = kind;
}

// ---- content assembly ----

function escapeMdText(s) {
  return s.replace(/([[\]\\])/g, "\\$1");
}

function sourceLine(page = currentTab) {
  if (!page.url) return "";
  const url = encodeURI(page.url).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `Source: [${escapeMdText(page.title || page.url)}](${url})`;
}

function buildContent(text, destination = target, page = currentTab) {
  const src = sourceLine(page);
  if (destination === "card") {
    const hasHeading = /^#\s/.test(text);
    const title = page.title ? `# ${page.title}` : "# Quick note";
    const parts = hasHeading ? [text] : [title, text];
    if (src) parts.push(src);
    return parts.join("\n\n");
  }
  return src ? `${text}\n\n${src}` : text;
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- actions ----

async function save() {
  const text = editorText().trim();
  if (!text) return;
  const submittedRevision = editorRevision;
  const submittedTarget = target;
  const submittedPage = { ...currentTab };
  saveBtn.disabled = true;
  setSaveButtonState("sending");
  setStatus(statusEl, "");

  try { await draftWrite; }
  catch (error) { setSaveButtonState("idle"); saveBtn.disabled = false; setStatus(statusEl, `Draft not saved: ${error.message}`, "error"); return; }

  const message = submittedTarget === "card"
    ? { action: "saveNote", content: buildContent(text, submittedTarget, submittedPage) }
    : { action: "appendJournal", content: buildContent(text, submittedTarget, submittedPage), date: localDate() };

  const res = await send(message);

  if (res.ok) {
    if (editorRevision === submittedRevision) {
      editor.contentEditable = "false";
      try { await clearEditor(); }
      catch (error) { setStatus(statusEl, `Sent, but draft cleanup failed: ${error.message}`, "error"); return; }
      finally { editor.contentEditable = "true"; }
      setSaveButtonState("sent");
    } else {
      setSaveButtonState("idle");
      saveBtn.disabled = editorText().trim() === "";
      setStatus(statusEl, "Sent previous draft. Newer text kept.", "success");
    }
    return;
  }
  setSaveButtonState("idle");
  saveBtn.disabled = editorText().trim() === "";
  if (res.authRequired) {
    showView(false);
    setStatus(connectStatusEl, "Sign-in required. Your draft is saved.");
    connectBtn.focus();
    return;
  }
  setStatus(statusEl, `Delivery unclear. Check Heptabase before retrying. ${res.error}`, "error");
}

async function connect() {
  connectBtn.disabled = true;
  connectBtn.setAttribute("aria-busy", "true");
  try { await draftWrite; }
  catch (error) { setStatus(connectStatusEl, `Draft not saved: ${error.message}`, "error"); connectBtn.disabled = false; connectBtn.setAttribute("aria-busy", "false"); return; }
  setStatus(connectStatusEl, "Complete authorization in the new tab…");
  const res = await send({ action: "connect" });
  connectBtn.disabled = false;
  connectBtn.setAttribute("aria-busy", "false");
  if (res.ok) {
    setStatus(connectStatusEl, "");
    showView(true);
  } else {
    setStatus(connectStatusEl, `Connection failed: ${res.error}`, "error");
  }
}

saveBtn.addEventListener("click", save);
connectBtn.addEventListener("click", connect);
editor.addEventListener("keydown", (e) => {
  if (composition.isActive(e)) return;
  if (handleCodeFenceKeys(editor, e)) {
    refreshStyles(editor);
    syncEditorState();
    return;
  }
  if (handleListEnter(editor, e)) {
    refreshStyles(editor);
    syncEditorState();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    save();
  }
});

// ---- init ----

(async function init() {
  await Promise.all([refreshTab(), restoreSession()]);
  const res = await send({ action: "status" });
  showView(Boolean(res.ok && res.data.connected));
})();
