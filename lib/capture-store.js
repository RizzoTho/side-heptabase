import { CAPTURE_MODES } from "./capture-content.js";

const PREFIX = "capture:draft:";
const LAST_SENT_KEY = "capture:last-sent";

export class CaptureStore {
  constructor(storage, { makeId = () => crypto.randomUUID(), now = () => Date.now() } = {}) {
    this.storage = storage;
    this.makeId = makeId;
    this.now = now;
    this.queues = new Map();
    this.activeSends = new Set();
  }

  key(tabId, mode) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Capture requires a browser tab");
    if (!CAPTURE_MODES.includes(mode)) throw new Error(`Unsupported capture mode: ${mode}`);
    return `${PREFIX}${tabId}:${mode}`;
  }

  async #locked(key, task) {
    const prior = this.queues.get(key) || Promise.resolve();
    const run = prior.catch(() => {}).then(task);
    this.queues.set(key, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === run) this.queues.delete(key);
    }
  }

  async #read(key) {
    return (await this.storage.get(key))[key] || null;
  }

  async save(tabId, { mode, id, text, sourceTitle, sourceUrl, journalDate }) {
    const key = this.key(tabId, mode);
    if (typeof text !== "string" || text.length > 100_000) throw new Error("Draft exceeds 100,000 characters");
    if (typeof sourceTitle !== "string" || typeof sourceUrl !== "string") throw new Error("Invalid page source");
    if (typeof journalDate !== "string") throw new Error("Journal date is missing");

    return this.#locked(key, async () => {
      const previous = await this.#read(key);
      if (previous && id && previous.id !== id) throw new Error("Draft changed in another view; reload to recover it");
      const draft = {
        id: previous?.id || this.makeId(),
        tabId,
        mode,
        text,
        sourceTitle: previous?.sourceTitle ?? sourceTitle,
        sourceUrl: previous?.sourceUrl ?? sourceUrl,
        journalDate: previous?.journalDate ?? journalDate,
        revision: (previous?.revision || 0) + 1,
        updatedAt: this.now(),
        delivery: previous?.delivery || "idle",
        submittedRevision: previous?.submittedRevision || null,
        error: previous?.error || null,
      };
      await this.storage.set({ [key]: draft });
      console.info("[capture] draft saved", { tabId, mode, id: draft.id, revision: draft.revision });
      return draft;
    });
  }

  async getAll(tabId, url) {
    const drafts = {};
    for (const mode of CAPTURE_MODES) {
      const key = this.key(tabId, mode);
      drafts[mode] = await this.#locked(key, async () => {
        const draft = await this.#read(key);
        if (draft?.delivery === "sending" && !this.activeSends.has(key)) {
          const recovered = {
            ...draft,
            delivery: "uncertain",
            error: "Delivery was interrupted. Check Heptabase before retrying.",
          };
          await this.storage.set({ [key]: recovered });
          console.warn("[capture] interrupted delivery", { tabId, mode, id: draft.id, revision: draft.revision });
          return recovered;
        }
        return draft;
      });
    }

    const candidates = {};
    if (url) {
      const all = await this.storage.get(null);
      for (const mode of CAPTURE_MODES) {
        if (drafts[mode]) continue;
        const matches = Object.entries(all)
          .filter(([key, draft]) => key.startsWith(PREFIX) && draft?.mode === mode
            && draft.sourceUrl === url && !draft.migratedTo && draft.tabId !== tabId
            && (draft.text.trim() || mode === "link"))
          .map(([key, draft]) => ({ key, draft }))
          .sort((a, b) => b.draft.updatedAt - a.draft.updatedAt);
        if (matches.length) candidates[mode] = { id: matches[0].draft.id, updatedAt: matches[0].draft.updatedAt };
      }
    }
    return { drafts, candidates, lastSent: (await this.storage.get(LAST_SENT_KEY))[LAST_SENT_KEY] || null };
  }

  async restore(tabId, { mode, candidateId, url }) {
    const targetKey = this.key(tabId, mode);
    if (!candidateId || !url) throw new Error("Recovery source is missing");
    return this.#locked(targetKey, async () => {
      if (await this.#read(targetKey)) throw new Error("This tab already has a draft");
      const all = await this.storage.get(null);
      const found = Object.entries(all).find(([key, draft]) => key.startsWith(PREFIX)
        && draft?.id === candidateId && draft.mode === mode && draft.sourceUrl === url && !draft.migratedTo);
      if (!found) throw new Error("Saved draft is no longer available");
      const [sourceKey, source] = found;
      const recovered = {
        ...source,
        id: this.makeId(),
        tabId,
        updatedAt: this.now(),
        delivery: source.delivery === "sending" ? "uncertain" : source.delivery,
        error: source.delivery === "sending" ? "Delivery was interrupted. Check Heptabase before retrying." : source.error,
      };
      await this.storage.set({ [targetKey]: recovered });
      await this.storage.set({ [sourceKey]: { ...source, migratedTo: targetKey } });
      console.info("[capture] draft restored", { tabId, mode, id: recovered.id, revision: recovered.revision });
      return recovered;
    });
  }

  async markSending(tabId, mode, id, revision, retryUncertain = false) {
    const key = this.key(tabId, mode);
    return this.#locked(key, async () => {
      const draft = await this.#read(key);
      if (!draft || draft.id !== id || draft.revision !== revision) throw new Error("Draft changed; send the latest version");
      if (draft.delivery === "sending") throw new Error("Draft is already sending");
      if (draft.delivery === "uncertain" && !retryUncertain) throw new Error("Check Heptabase before retrying this draft");
      const sending = { ...draft, delivery: "sending", submittedRevision: revision, error: null };
      await this.storage.set({ [key]: sending });
      this.activeSends.add(key);
      console.info("[capture] send started", { tabId, mode, id, revision });
      return sending;
    });
  }

  async finish(tabId, mode, id, submittedRevision, outcome, error = null) {
    const key = this.key(tabId, mode);
    try {
      return await this.#locked(key, async () => {
        const current = await this.#read(key);
        if (!current || current.id !== id || current.submittedRevision !== submittedRevision) {
          throw new Error("Submitted draft no longer matches the stored record");
        }
        if (outcome === "sent") {
          await this.storage.set({ [LAST_SENT_KEY]: { mode, at: this.now() } });
          if (current.revision === submittedRevision) {
            await this.storage.remove(key);
            console.info("[capture] send confirmed and draft cleared", { tabId, mode, id, revision: submittedRevision });
            return { cleared: true };
          }
          const newer = { ...current, delivery: "idle", submittedRevision: null, error: null };
          await this.storage.set({ [key]: newer });
          console.info("[capture] send confirmed; newer draft kept", { tabId, mode, id, revision: newer.revision });
          return { cleared: false, draft: newer };
        }
        if (!(["auth", "uncertain", "error"].includes(outcome))) throw new Error(`Unknown delivery outcome: ${outcome}`);
        const kept = { ...current, delivery: outcome, error: error || null };
        await this.storage.set({ [key]: kept });
        console.warn("[capture] send not confirmed", { tabId, mode, id, revision: submittedRevision, outcome, error });
        return { cleared: false, draft: kept };
      });
    } finally {
      this.activeSends.delete(key);
    }
  }

  async clearAuthStates() {
    const all = await this.storage.get(null);
    for (const [key, draft] of Object.entries(all)) {
      if (!key.startsWith(PREFIX) || draft?.delivery !== "auth") continue;
      await this.#locked(key, async () => {
        const latest = await this.#read(key);
        if (latest?.delivery === "auth") {
          await this.storage.set({ [key]: { ...latest, delivery: "idle", error: null, submittedRevision: null } });
        }
      });
    }
    console.info("[capture] authorization drafts ready");
  }
}
