import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureRequest } from "../lib/capture-content.js";
import { CaptureStore } from "../lib/capture-store.js";

class MemoryStorage {
  data = {};
  async get(keys) {
    if (keys === null) return structuredClone(this.data);
    const selected = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
}

const page = {
  sourceTitle: "Reading [notes]",
  sourceUrl: "https://example.com/a(b)",
  journalDate: "2026-11-05",
};
const draft = (mode, text) => ({ ...page, mode, text });
const counted = (storage = new MemoryStorage(), start = 0) => {
  let sequence = start;
  return new CaptureStore(storage, { makeId: () => `draft-${++sequence}`, now: () => 100 });
};

describe("capture requests", () => {
  test("journal appends trimmed text to the local-date journal", () => {
    assert.deepEqual(buildCaptureRequest(draft("journal", "  An idea\n")), {
      tool: "append_to_journal",
      args: { content: "An idea", date: "2026-11-05" },
    });
  });

  test("todo writes one unchecked item and indents every continuation line", () => {
    assert.deepEqual(buildCaptureRequest(draft("todo", "Ship this\n\n\nReview it")), {
      tool: "append_to_journal",
      args: { content: "- [ ] Ship this\n  Review it", date: "2026-11-05" },
    });
  });

  test("link writes a toggle item with the title escaped and the url paren-safe", () => {
    assert.deepEqual(buildCaptureRequest(draft("link", "")), {
      tool: "append_to_journal",
      args: { content: "+ [Reading \\[notes\\]](https://example.com/a%28b%29)", date: "2026-11-05" },
    });
  });

  test("link keeps typed text as indented children of the toggle item", () => {
    assert.deepEqual(buildCaptureRequest(draft("link", "First line\nSecond line")), {
      tool: "append_to_journal",
      args: {
        content: "+ [Reading \\[notes\\]](https://example.com/a%28b%29)\n  First line\n  Second line",
        date: "2026-11-05",
      },
    });
  });

  test("link refuses a page that has no http link", () => {
    assert.throws(() => buildCaptureRequest({ ...draft("link", ""), sourceUrl: "chrome://extensions" }), /no HTTP link/);
  });

  test("note prepends the page title when the text has no heading", () => {
    assert.deepEqual(buildCaptureRequest(draft("note", "An idea")), {
      tool: "create_object",
      args: {
        objectType: "card",
        content: "# Reading [notes]\n\nAn idea\n\nSource: [Reading \\[notes\\]](https://example.com/a%28b%29)",
      },
    });
  });

  test("note keeps a leading H1 as the card title instead of duplicating it", () => {
    const request = buildCaptureRequest(draft("note", "# My title\n\nBody"));
    assert.equal(request.args.content.startsWith("# My title\n\nBody"), true);
    assert.equal(request.args.content.includes("# Reading [notes]"), false);
  });

  test("note falls back to a generic title when the page has none", () => {
    const request = buildCaptureRequest({ ...draft("note", "An idea"), sourceTitle: "" });
    assert.equal(request.args.content.startsWith("# Quick note\n\nAn idea"), true);
  });

  test("note omits the source section for non-http pages", () => {
    const request = buildCaptureRequest({ ...draft("note", "An idea"), sourceUrl: "chrome://extensions" });
    assert.equal(request.args.content.includes("Source:"), false);
  });

  for (const mode of ["journal", "todo", "note"]) {
    test(`${mode} rejects an empty capture`, () => {
      assert.throws(() => buildCaptureRequest(draft(mode, "   ")), /is empty/);
    });
  }

  test("an unknown mode or a missing date is rejected before any MCP call", () => {
    assert.throws(() => buildCaptureRequest(draft("bookmark", "x")), /Unsupported capture mode/);
    assert.throws(() => buildCaptureRequest({ ...draft("journal", "x"), journalDate: "05/11/2026" }), /Journal date is missing/);
  });
});

describe("capture store", () => {
  test("each save bumps the revision that a send is matched against", async () => {
    const store = counted();
    const first = await store.save(11, draft("journal", "One"));
    const second = await store.save(11, draft("journal", "Two"));
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(second.id, first.id);
  });

  test("a stale revision cannot start a send", async () => {
    const store = counted();
    const stale = await store.save(12, draft("journal", "One"));
    const current = await store.save(12, draft("journal", "Two"));
    await assert.rejects(store.markSending(12, "journal", current.id, stale.revision), /Draft changed/);
  });

  test("saving into a slot owned by another draft id is refused", async () => {
    const store = counted();
    await store.save(13, draft("journal", "Mine"));
    await assert.rejects(store.save(13, { ...draft("journal", "Theirs"), id: "other-view" }), /changed in another view/);
  });

  test("confirmed send clears only the submitted revision", async () => {
    const store = counted();
    const first = await store.save(14, draft("journal", "One"));
    await store.markSending(14, "journal", first.id, first.revision);
    const newer = await store.save(14, { ...draft("journal", "Newer text"), id: first.id });
    const result = await store.finish(14, "journal", first.id, first.revision, "sent");
    assert.equal(result.cleared, false);
    assert.equal(result.draft.text, "Newer text");
    assert.equal(result.draft.revision, newer.revision);
    assert.equal(result.draft.delivery, "idle");
    assert.deepEqual((await store.getAll(14, page.sourceUrl)).lastSent, { mode: "journal", at: 100 });
  });

  test("confirmed send removes an unchanged draft", async () => {
    const store = counted();
    const saved = await store.save(15, draft("link", ""));
    await store.markSending(15, "link", saved.id, saved.revision);
    const result = await store.finish(15, "link", saved.id, saved.revision, "sent");
    assert.equal(result.cleared, true);
    assert.equal((await store.getAll(15, page.sourceUrl)).drafts.link, null);
  });

  test("auth failure keeps the draft and reconnect readies it", async () => {
    const store = counted();
    const saved = await store.save(16, draft("note", "An idea"));
    await store.markSending(16, "note", saved.id, saved.revision);
    await store.finish(16, "note", saved.id, saved.revision, "auth", "Sign-in required");
    assert.equal((await store.getAll(16, page.sourceUrl)).drafts.note.delivery, "auth");
    await store.clearAuthStates();
    const ready = (await store.getAll(16, page.sourceUrl)).drafts.note;
    assert.equal(ready.delivery, "idle");
    assert.equal(ready.text, "An idea");
  });

  test("an interrupted send becomes uncertain and cannot retry silently", async () => {
    const storage = new MemoryStorage();
    const firstWorker = counted(storage);
    const saved = await firstWorker.save(17, draft("journal", "An idea"));
    await firstWorker.markSending(17, "journal", saved.id, saved.revision);
    const restartedWorker = new CaptureStore(storage);
    const recovered = (await restartedWorker.getAll(17, page.sourceUrl)).drafts.journal;
    assert.equal(recovered.delivery, "uncertain");
    await assert.rejects(restartedWorker.markSending(17, "journal", saved.id, saved.revision), /Check Heptabase/);
    await restartedWorker.markSending(17, "journal", saved.id, saved.revision, true);
  });

  test("a draft from a previous tab is offered as a candidate, not as this tab's draft", async () => {
    const store = counted();
    const old = await store.save(21, draft("todo", "Remember this"));
    const next = await store.getAll(22, page.sourceUrl);
    assert.equal(next.drafts.todo, null);
    assert.equal(next.candidates.todo.id, old.id);
  });

  test("restore moves the candidate into the current tab and marks the source migrated", async () => {
    const storage = new MemoryStorage();
    const store = counted(storage);
    const old = await store.save(23, draft("todo", "Remember this"));
    const restored = await store.restore(24, { mode: "todo", candidateId: old.id, url: page.sourceUrl });
    assert.equal(restored.text, "Remember this");
    assert.notEqual(restored.id, old.id);
    assert.equal((await store.getAll(24, page.sourceUrl)).candidates.todo, undefined);
    assert.equal((await store.getAll(23, page.sourceUrl)).drafts.todo.migratedTo, "capture:draft:24:todo");
  });

  test("restore refuses a candidate recorded for a different page", async () => {
    const store = counted();
    const old = await store.save(25, draft("todo", "Remember this"));
    await assert.rejects(
      store.restore(26, { mode: "todo", candidateId: old.id, url: "https://elsewhere.example/x" }),
      /no longer available/,
    );
  });

  test("an empty draft is never offered for recovery", async () => {
    const store = counted();
    await store.save(27, draft("journal", "   "));
    assert.equal((await store.getAll(28, page.sourceUrl)).candidates.journal, undefined);
  });
});
