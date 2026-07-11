const editor = document.getElementById("editor");
const pageTitleEl = document.getElementById("page-title");
const pageUrlEl = document.getElementById("page-url");
const saveBtn = document.getElementById("save-btn");
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const statusEl = document.getElementById("status");

const DRAFT_KEY = "draft";
let currentTab = { title: "", url: "" };

// ---- current tab tracking ----

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    currentTab = { title: tab?.title || "", url: "" };
  } else {
    currentTab = { title: tab.title || tab.url, url: tab.url };
  }
  pageTitleEl.textContent = currentTab.title || "（无页面）";
  pageUrlEl.textContent = currentTab.url;
}

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.url || info.status === "complete") refreshTab();
});

// ---- draft persistence (survives panel close within the browser session) ----

editor.addEventListener("input", () => {
  chrome.storage.session.set({ [DRAFT_KEY]: editor.value });
});

async function restoreDraft() {
  const { [DRAFT_KEY]: draft } = await chrome.storage.session.get(DRAFT_KEY);
  if (draft) editor.value = draft;
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

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function setConnectedUI(connected) {
  saveBtn.hidden = !connected;
  connectBtn.hidden = connected;
  disconnectBtn.hidden = !connected;
}

// ---- content assembly ----

function escapeMdText(s) {
  return s.replace(/([[\]\\])/g, "\\$1");
}

function sourceLine() {
  if (!currentTab.url) return "";
  return `Source: [${escapeMdText(currentTab.title || currentTab.url)}](${currentTab.url})`;
}

function buildContent(target, text) {
  const src = sourceLine();
  if (target === "card") {
    const hasHeading = /^#\s/.test(text);
    const title = currentTab.title ? `# ${currentTab.title}` : "# Quick note";
    const parts = hasHeading ? [text] : [title, text];
    if (src) parts.push(src);
    return parts.join("\n\n");
  }
  // journal: no heading requirement
  return src ? `${text}\n\n${src}` : text;
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- actions ----

async function save() {
  const text = editor.value.trim();
  if (!text) {
    setStatus("笔记内容为空", "error");
    return;
  }
  const target = document.querySelector('input[name="target"]:checked').value;
  saveBtn.disabled = true;
  setStatus(target === "card" ? "正在保存卡片…" : "正在写入 Journal…");

  const message = target === "card"
    ? { action: "saveNote", content: buildContent("card", text) }
    : { action: "appendJournal", content: buildContent("journal", text), date: localDate() };

  const res = await send(message);
  saveBtn.disabled = false;

  if (res.ok) {
    editor.value = "";
    chrome.storage.session.remove(DRAFT_KEY);
    setStatus(target === "card" ? "✅ 已保存为笔记卡片" : "✅ 已追加到今日 Journal", "success");
    return;
  }
  if (res.authRequired) {
    setConnectedUI(false);
    setStatus("需要重新连接 Heptabase", "error");
    return;
  }
  setStatus(`保存失败：${res.error}`, "error");
}

async function connect() {
  connectBtn.disabled = true;
  setStatus("等待授权…");
  const res = await send({ action: "connect" });
  connectBtn.disabled = false;
  if (res.ok) {
    setConnectedUI(true);
    setStatus("✅ 已连接", "success");
  } else {
    setStatus(`连接失败：${res.error}`, "error");
  }
}

async function disconnect() {
  await send({ action: "disconnect" });
  setConnectedUI(false);
  setStatus("已断开连接");
}

saveBtn.addEventListener("click", save);
connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
editor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !saveBtn.hidden) save();
});

// ---- init ----

(async function init() {
  await Promise.all([refreshTab(), restoreDraft()]);
  const res = await send({ action: "status" });
  setConnectedUI(Boolean(res.ok && res.data.connected));
  if (!(res.ok && res.data.connected)) setStatus("首次使用请先连接 Heptabase");
})();
