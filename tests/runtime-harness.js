import { CaptureStore } from "../lib/capture-store.js";
import { buildCaptureRequest } from "../lib/capture-content.js";

class MemoryStorage {
  data = {};
  async get(keys) {
    if (keys === null) return structuredClone(this.data);
    const names = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(names.filter((name) => name in this.data).map((name) => [name, structuredClone(this.data[name])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
  async remove(keys) { for (const name of Array.isArray(keys) ? keys : [keys]) delete this.data[name]; }
}

const storage = new MemoryStorage();
const captures = new CaptureStore(storage);
const tabId = 1;
let metaAction = "side-panel";
let appearance = "light";
let authNext = false;
let holdNext = false;
let releaseSend = null;
const panel = document.getElementById("mock-panel");
document.getElementById("close-panel").addEventListener("click", () => { panel.hidden = true; });
document.getElementById("hold-send").addEventListener("click", () => { holdNext = true; });
document.getElementById("release-send").addEventListener("click", () => { releaseSend?.(); releaseSend = null; });
document.getElementById("auth-next").addEventListener("click", () => { authNext = true; });

async function handle(message) {
  switch (message.action) {
    case "captureState": return { ...await captures.getAll(tabId, location.href), metaAction, appearance };
    case "captureSave": return captures.save(tabId, message.draft);
    case "captureRestore": return captures.restore(tabId, { ...message, url: location.href });
    case "captureSubmit": {
      const draft = await captures.markSending(tabId, message.mode, message.id, message.revision, message.retryUncertain);
      buildCaptureRequest(draft);
      if (holdNext) {
        holdNext = false;
        await new Promise((resolve) => { releaseSend = resolve; });
      }
      if (authNext) {
        authNext = false;
        await captures.finish(tabId, message.mode, draft.id, draft.revision, "auth", "Sign-in required");
        return { authRequired: true, deliveryState: "auth", error: "Sign-in required" };
      }
      const result = await captures.finish(tabId, message.mode, draft.id, draft.revision, "sent");
      return { sent: true, ...result };
    }
    case "captureConnectionStatus": return { state: "connected" };
    case "captureSetMetaAction": metaAction = message.metaAction; return { metaAction };
    case "captureSetAppearance": appearance = message.appearance; return { appearance };
    case "captureOpenSidePanel": panel.hidden = false; return { opened: true };
    case "connect": await captures.clearAuthStates(); return { connected: true };
    default: throw new Error(`Unknown test action: ${message.action}`);
  }
}

window.chrome = {
  runtime: {
    getURL: (path) => new URL(`/${path}`, location.href).href,
    sendMessage: async (message) => {
      try {
        const result = await handle(message);
        if (result?.authRequired) return { ok: false, ...result };
        return { ok: true, data: result };
      } catch (error) { return { ok: false, error: error.message }; }
    },
  },
};

window.runtimeHarness = { armAuth: () => { authNext = true; }, getStorage: () => structuredClone(storage.data) };

for (const path of ["floating/icons.js", "floating/meta-icon.js", "floating/floating.js"]) {
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(`/${path}`, location.href).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${path}`));
    document.body.append(script);
  });
}

document.getElementById("hover-reentry").addEventListener("click", () => {
  const shadow = document.getElementById("side-heptabase-root").shadowRoot;
  const shell = shadow.querySelector(".utility-shell");
  const capture = shadow.querySelector(".capture");
  const pointer = (type, x = 0, y = 0) => new PointerEvent(type, { pointerType: "mouse", clientX: x, clientY: y, bubbles: ["pointerdown", "pointermove"].includes(type) });
  shell.dispatchEvent(pointer("pointerenter"));
  const opened = capture.dataset.open === "true";
  shell.dispatchEvent(pointer("pointerleave", innerWidth - 1, innerHeight / 2));
  document.dispatchEvent(pointer("pointermove"));
  const collapsedByMove = capture.dataset.open === "false";
  shell.dispatchEvent(pointer("pointerenter"));
  const reopenedAfterMove = capture.dataset.open === "true";
  shell.dispatchEvent(pointer("pointerleave", innerWidth - 1, innerHeight / 2));
  document.dispatchEvent(pointer("pointerdown"));
  const collapsedByClick = capture.dataset.open === "false";
  shell.dispatchEvent(pointer("pointerenter"));
  const reopenedAfterClick = capture.dataset.open === "true";
  const checks = { opened, collapsedByMove, reopenedAfterMove, collapsedByClick, reopenedAfterClick };
  document.getElementById("hover-result").textContent = Object.values(checks).every(Boolean) ? "Hover reentry: pass" : `Hover reentry: fail ${JSON.stringify(checks)}`;
});
