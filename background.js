// Service worker: owns the OAuth session and all Heptabase MCP calls.
// The side panel talks to it via chrome.runtime messages.

import { authorize, clearTokens, isConnected, AuthRequiredError } from "./lib/oauth.js";
import { callTool } from "./lib/mcp-client.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const handlers = {
  async status() {
    return { connected: await isConnected() };
  },
  async connect() {
    await authorize();
    return { connected: true };
  },
  async disconnect() {
    await clearTokens();
    return { connected: false };
  },
  async saveNote({ content }) {
    return callTool("save_to_note_card", { content });
  },
  async appendJournal({ content, date }) {
    return callTool("append_to_journal", { content, date });
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.action];
  if (!handler) return false;
  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({
      ok: false,
      error: e.message || String(e),
      authRequired: e instanceof AuthRequiredError,
    }));
  return true; // keep the message channel open for the async response
});
