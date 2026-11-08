// Service worker: owns the OAuth session and all Heptabase MCP calls.
// The side panel talks to it via chrome.runtime messages.

import { authorize, clearTokens, isConnected, AuthRequiredError } from "./lib/oauth.js";
import { callTool, listTools, McpPreflightError } from "./lib/mcp-client.js";
import { buildCaptureRequest } from "./lib/capture-content.js";
import { CaptureStore } from "./lib/capture-store.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
storageReady.catch((error) => console.error("[capture] local storage access restriction failed", { error: error.message }));
const captures = new CaptureStore(chrome.storage.local);
const META_ACTION_KEY = "capture:meta-action";
const APPEARANCE_KEY = "capture:appearance";
const FLOATING_SCRIPTS = ["floating/icons.js", "floating/meta-icon.js", "floating/floating.js"];

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const eligible = tabs.filter((tab) => Number.isInteger(tab.id)
    && /^https?:\/\//.test(tab.url || "")
    && !/^https:\/\/api\.heptabase\.com\//.test(tab.url));
  const results = await Promise.allSettled(eligible.map(async (tab) => {
    const target = { tabId: tab.id };
    // Reloading an unpacked extension can leave an old content-script DOM node in an open tab.
    await chrome.scripting.executeScript({ target, func: () => {
      const previous = document.getElementById("side-heptabase-root");
      if (!previous) return;
      const hidden = previous.shadowRoot?.querySelector(".capture")?.dataset.hidden === "true";
      previous.remove();
      if (hidden) document.documentElement.dataset.sideHeptabaseHiddenUntilRefresh = "true";
    } });
    await chrome.scripting.insertCSS({ target, files: ["floating/editor-inline.css"] });
    await chrome.scripting.executeScript({ target, files: FLOATING_SCRIPTS });
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn("[capture] existing tab injection failed", { tabId: eligible[index].id, error: result.reason?.message || String(result.reason) });
  });
  console.info("[capture] existing tabs checked", { eligible: eligible.length, injected: results.filter((result) => result.status === "fulfilled").length });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (!["install", "update"].includes(details.reason)) return;
  return injectIntoOpenTabs().catch((error) => console.error("[capture] existing tab scan failed", { error: error.message }));
});

function tabId(sender) {
  if (!Number.isInteger(sender.tab?.id)) throw new Error("This action needs a browser tab");
  return sender.tab.id;
}

async function submitCapture(message, sender) {
  const id = tabId(sender);
  const draft = await captures.markSending(id, message.mode, message.id, message.revision, message.retryUncertain === true);
  let request;
  try {
    request = buildCaptureRequest(draft);
  } catch (error) {
    await captures.finish(id, message.mode, draft.id, draft.revision, "error", error.message);
    error.deliveryState = "error";
    throw error;
  }
  try {
    await callTool(request.tool, request.args);
  } catch (error) {
    const outcome = error instanceof AuthRequiredError ? "auth" : error instanceof McpPreflightError ? "error" : "uncertain";
    await captures.finish(id, message.mode, draft.id, draft.revision, outcome, error.message);
    error.deliveryState = outcome;
    throw error;
  }
  const result = await captures.finish(id, message.mode, draft.id, draft.revision, "sent");
  return { sent: true, ...result };
}

async function liveConnectionStatus() {
  if (!(await isConnected())) return { state: "auth" };
  try {
    const names = new Set((await listTools()).map((tool) => tool.name));
    return { state: names.has("create_object") && names.has("append_to_journal") ? "connected" : "read-only" };
  } catch (error) {
    if (error instanceof AuthRequiredError) return { state: "auth" };
    console.warn("[capture] MCP status check failed", { error: error.name });
    return { state: "unavailable", error: error.message };
  }
}

const handlers = {
  async status() {
    return { connected: await isConnected() };
  },
  async connect() {
    await authorize();
    await captures.clearAuthStates();
    return { connected: true };
  },
  async disconnect() {
    await clearTokens();
    return { connected: false };
  },
  async saveNote({ content }) {
    return callTool("create_object", { objectType: "card", content });
  },
  async appendJournal({ content, date }) {
    return callTool("append_to_journal", { content, date });
  },
  async captureState(_message, sender) {
    const state = await captures.getAll(tabId(sender), sender.tab.url || "");
    const { [META_ACTION_KEY]: metaAction, [APPEARANCE_KEY]: appearance } = await chrome.storage.local.get([META_ACTION_KEY, APPEARANCE_KEY]);
    return { ...state, metaAction: metaAction === "last-capture" ? metaAction : "side-panel", appearance: appearance === "dark" ? "dark" : "light" };
  },
  async captureSave(message, sender) {
    return captures.save(tabId(sender), message.draft);
  },
  async captureRestore(message, sender) {
    return captures.restore(tabId(sender), { ...message, url: sender.tab.url || "" });
  },
  captureSubmit: submitCapture,
  async captureConnectionStatus() {
    return liveConnectionStatus();
  },
  async captureSetMetaAction({ metaAction }) {
    if (!["side-panel", "last-capture"].includes(metaAction)) throw new Error("Unsupported Meta action");
    await chrome.storage.local.set({ [META_ACTION_KEY]: metaAction });
    return { metaAction };
  },
  async captureSetAppearance({ appearance }) {
    if (!["light", "dark"].includes(appearance)) throw new Error("Unsupported appearance");
    await chrome.storage.local.set({ [APPEARANCE_KEY]: appearance });
    return { appearance };
  },
  async captureOpenSidePanel(_message, sender) {
    if (!Number.isInteger(sender.tab?.windowId)) throw new Error("Window is unavailable");
    await chrome.sidePanel.open({ windowId: sender.tab.windowId });
    console.info("[capture] side panel opened", { windowId: sender.tab.windowId });
    return { opened: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.action];
  if (!handler) return false;
  // sidePanel.open must run in the original click task; awaiting storageReady loses Dia's user gesture.
  const operation = message.action === "captureOpenSidePanel"
    ? handler(message, sender)
    : storageReady.then(() => handler(message, sender));
  operation
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => {
      console.error("[capture] action failed", { action: message.action, error: e.name, deliveryState: e.deliveryState || null });
      sendResponse({
        ok: false,
        error: e.message || String(e),
        authRequired: e instanceof AuthRequiredError,
        deliveryState: e.deliveryState || null,
      });
    });
  return true; // keep the message channel open for the async response
});
