const editorView = document.getElementById("editor-view");
const connectView = document.getElementById("connect-view");
const editor = document.getElementById("editor");
const editorCard = document.getElementById("editor-card");
const sourceTitleEl = document.getElementById("source-title");
const tabButtons = [...document.querySelectorAll("#tabs .tab")];
const saveBtn = document.getElementById("save-btn");
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const statusEl = document.getElementById("status");
const connectStatusEl = document.getElementById("connect-status");

const DRAFT_KEY = "draft";
let currentTab = { title: "", url: "" };
let target = "card"; // "card" | "journal"

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
  sourceTitleEl.textContent = currentTab.title || "（无页面）";
  sourceTitleEl.title = currentTab.url;
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
    btn.setAttribute("aria-selected", String(active));
  }
  editorCard.classList.toggle("journal-active", next === "journal");
  chrome.storage.session.set({ target: next });
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => setTarget(btn.dataset.target));
}

// ---- draft persistence ----

function syncSaveBtn() {
  saveBtn.disabled = editor.value.trim() === "";
}

editor.addEventListener("input", () => {
  chrome.storage.session.set({ [DRAFT_KEY]: editor.value });
  syncSaveBtn();
});

async function restoreSession() {
  const { [DRAFT_KEY]: draft, target: savedTarget } = await chrome.storage.session.get([DRAFT_KEY, "target"]);
  if (draft) editor.value = draft;
  if (savedTarget) setTarget(savedTarget);
  syncSaveBtn();
}

// ---- messaging ----

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    // undefined = the service worker died before responding
    return res ?? { ok: false, error: "后台服务无响应，请重试" };
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

function sourceLine() {
  if (!currentTab.url) return "";
  return `Source: [${escapeMdText(currentTab.title || currentTab.url)}](${currentTab.url})`;
}

function buildContent(text) {
  const src = sourceLine();
  if (target === "card") {
    const hasHeading = /^#\s/.test(text);
    const title = currentTab.title ? `# ${currentTab.title}` : "# Quick note";
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
  const text = editor.value.trim();
  if (!text) return;
  saveBtn.disabled = true;
  setStatus(statusEl, target === "card" ? "正在保存卡片…" : "正在写入 Journal…");

  const message = target === "card"
    ? { action: "saveNote", content: buildContent(text) }
    : { action: "appendJournal", content: buildContent(text), date: localDate() };

  const res = await send(message);

  if (res.ok) {
    editor.value = "";
    chrome.storage.session.remove(DRAFT_KEY);
    syncSaveBtn();
    setStatus(statusEl, target === "card" ? "✅ 已保存为笔记卡片" : "✅ 已追加到今日 Journal", "success");
    return;
  }
  syncSaveBtn();
  if (res.authRequired) {
    showView(false);
    setStatus(connectStatusEl, "登录状态已过期，请重新连接");
    return;
  }
  setStatus(statusEl, `保存失败：${res.error}`, "error");
}

async function connect() {
  connectBtn.disabled = true;
  setStatus(connectStatusEl, "已打开授权页，请在新标签页完成授权…");
  const res = await send({ action: "connect" });
  connectBtn.disabled = false;
  if (res.ok) {
    setStatus(connectStatusEl, "");
    setStatus(statusEl, "✅ 已连接", "success");
    showView(true);
  } else {
    setStatus(connectStatusEl, `连接失败：${res.error}`, "error");
  }
}

async function disconnect() {
  await send({ action: "disconnect" });
  setStatus(connectStatusEl, "");
  showView(false);
}

saveBtn.addEventListener("click", save);
connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
editor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
});

// ---- init ----

(async function init() {
  await Promise.all([refreshTab(), restoreSession()]);
  const res = await send({ action: "status" });
  showView(Boolean(res.ok && res.data.connected));
})();
