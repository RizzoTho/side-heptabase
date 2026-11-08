import { describe, test } from "node:test";
import assert from "node:assert/strict";

const FLOATING_SCRIPTS = ["floating/icons.js", "floating/meta-icon.js", "floating/floating.js"];
const ARTICLE = "https://example.com/article";
let importCount = 0;

class MemoryStorage {
  data = {
    hepta_tokens: { accessToken: "token-1", refreshToken: null, expiresAt: Date.now() + 3_600_000 },
  };
  accessLevel = null;
  gate = null;

  async get(keys) {
    if (keys === null) return structuredClone(this.data);
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
  async setAccessLevel({ accessLevel }) {
    if (this.gate) await this.gate;
    this.accessLevel = accessLevel;
  }
}

// Loads a fresh copy of the service worker against stubbed browser APIs.
async function startWorker({ blockStorage = false } = {}) {
  const storage = new MemoryStorage();
  let releaseStorage = () => {};
  if (blockStorage) storage.gate = new Promise((resolve) => { releaseStorage = resolve; });
  const calls = [];
  const opened = [];
  const injections = [];
  const tabs = [
    { id: 41, url: ARTICLE },
    { id: 42, url: "https://api.heptabase.com/login" },
    { id: 43, url: "chrome://extensions" },
  ];
  let failNextTool = null;
  let inUserGesture = false;
  let listener;
  let installedListener;

  globalThis.chrome = {
    storage: { local: storage },
    tabs: { query: async () => tabs },
    scripting: {
      insertCSS: async (options) => { injections.push({ kind: "css", ...options }); },
      executeScript: async (options) => { injections.push({ kind: options.func ? "host-reset" : "scripts", ...options }); },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      open: async (options) => {
        assert.equal(inUserGesture, true, "chrome.sidePanel.open must run inside the message handler");
        opened.push(options);
      },
    },
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      onInstalled: { addListener(callback) { installedListener = callback; } },
    },
  };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const result = request.method === "tools/list"
      ? { tools: [{ name: "create_object" }, { name: "append_to_journal" }] }
      : { isError: false, structuredContent: { status: failNextTool ? "failed" : "succeeded", content: failNextTool || undefined } };
    failNextTool = null;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ jsonrpc: "2.0", id: request.id, result }),
    };
  };

  await import(`${new URL("../background.js", import.meta.url).href}?case=${++importCount}`);
  assert.equal(typeof installedListener, "function");
  assert.equal(typeof listener, "function");

  const sender = { tab: { id: 41, windowId: 7, url: ARTICLE } };
  const message = (payload) => new Promise((resolve) => {
    inUserGesture = true;
    try { assert.equal(listener(payload, sender, resolve), true); } finally { inUserGesture = false; }
  });

  return {
    storage,
    releaseStorage,
    calls,
    opened,
    injections,
    message,
    failTool: (reason) => { failNextTool = reason; },
    installed: (reason = "update") => installedListener({ reason }),
    lastToolCall: () => calls.filter((call) => call.method === "tools/call").at(-1),
  };
}

describe("service worker", () => {
  test("reloading the extension injects the floating control into eligible tabs only", async () => {
    const worker = await startWorker();
    await worker.installed("update");

    assert.deepEqual(worker.injections.map((item) => item.target.tabId), [41, 41, 41], "only the http article tab is touched");
    // Order matters: drop a stale host, add the inline editor CSS, then run the scripts.
    assert.deepEqual(worker.injections.map((item) => item.kind), ["host-reset", "css", "scripts"]);
    assert.deepEqual(worker.injections[1].files, ["floating/editor-inline.css"]);
    assert.deepEqual(worker.injections[2].files, FLOATING_SCRIPTS);
  });

  test("installing for the first time also injects into open tabs", async () => {
    const worker = await startWorker();
    await worker.installed("install");
    assert.deepEqual(worker.injections.map((item) => item.target.tabId), [41, 41, 41]);
  });

  test("other lifecycle reasons skip the tab scan", async () => {
    const worker = await startWorker();
    await worker.installed("chrome_update");
    assert.deepEqual(worker.injections, []);
  });

  test("runtime messages wait for the storage access restriction", async () => {
    const worker = await startWorker({ blockStorage: true });

    let answered = false;
    const pending = worker.message({ action: "status" }).then((value) => { answered = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answered, false, "no reply before trusted-context storage is locked down");

    worker.releaseStorage();
    const status = await pending;
    assert.equal(worker.storage.accessLevel, "TRUSTED_CONTEXTS");
    assert.equal(status.data.connected, true);
  });

  test("the side panel opens from inside the message handler", async () => {
    const worker = await startWorker();
    const result = await worker.message({ action: "captureOpenSidePanel" });
    assert.deepEqual(result.data, { opened: true });
    assert.deepEqual(worker.opened, [{ windowId: 7 }]);
  });

  for (const [mode, tool, assertion] of [
    ["journal", "append_to_journal", (args) => assert.equal(args.content, "Remember")],
    ["todo", "append_to_journal", (args) => assert.equal(args.content, "- [ ] Remember")],
    ["note", "create_object", (args) => assert.equal(args.objectType, "card")],
    ["link", "append_to_journal", (args) => assert.match(args.content, /\+ \[Article\]\(https:\/\/example\.com\/article\)/)],
  ]) {
    test(`${mode} captures reach ${tool} and clear the submitted draft`, async () => {
      const worker = await startWorker();
      const saved = await worker.message({ action: "captureSave", draft: { mode, text: "Remember", sourceTitle: "Article", sourceUrl: ARTICLE, journalDate: "2026-11-05" } });
      assert.equal(saved.ok, true);

      const submitted = await worker.message({ action: "captureSubmit", mode, id: saved.data.id, revision: saved.data.revision });
      assert.equal(submitted.ok, true);
      assert.equal(submitted.data.cleared, true);

      const call = worker.lastToolCall();
      assert.equal(call.params.name, tool);
      assertion(call.params.arguments);
      assert.equal((await worker.message({ action: "captureState" })).data.drafts[mode], null);
    });
  }

  test("a rejected tool call keeps the draft and marks the delivery uncertain", async () => {
    const worker = await startWorker();
    const saved = await worker.message({ action: "captureSave", draft: { mode: "journal", text: "Keep this", sourceTitle: "Article", sourceUrl: ARTICLE, journalDate: "2026-11-05" } });
    worker.failTool("Rejected by Heptabase");

    const submitted = await worker.message({ action: "captureSubmit", mode: "journal", id: saved.data.id, revision: saved.data.revision });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.deliveryState, "uncertain");

    const state = await worker.message({ action: "captureState" });
    assert.equal(state.data.drafts.journal.text, "Keep this");
    assert.equal(state.data.drafts.journal.delivery, "uncertain");
  });

  test("an outdated Heptabase app surfaces its own error state", async () => {
    const worker = await startWorker();
    const saved = await worker.message({ action: "captureSave", draft: { mode: "note", text: "Still here", sourceTitle: "Article", sourceUrl: ARTICLE, journalDate: "2026-11-05" } });
    worker.failTool("The open Heptabase app is too old for this action. Ask the user to update the Heptabase app, then retry. Ran on: Heptabase client (desktop)");

    const submitted = await worker.message({ action: "captureSubmit", mode: "note", id: saved.data.id, revision: saved.data.revision });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.deliveryState, "error");
    assert.match(submitted.error, /Heptabase app is too old/);
    assert.equal((await worker.message({ action: "captureState" })).data.drafts.note.delivery, "error");
  });
});
