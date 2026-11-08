export const CAPTURE_MODES = Object.freeze(["journal", "todo", "note", "link"]);

export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function linkMarkdown(title, url) {
  if (!/^https?:\/\//i.test(url || "")) throw new Error("This page has no HTTP link to save");
  const label = (title || url).replace(/([\\[\]])/g, "\\$1");
  const target = encodeURI(url).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${label}](${target})`;
}

export function buildCaptureRequest(draft) {
  if (!CAPTURE_MODES.includes(draft.mode)) throw new Error(`Unsupported capture mode: ${draft.mode}`);
  const text = draft.text.trim();
  const date = draft.journalDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Journal date is missing");

  switch (draft.mode) {
    case "journal":
      if (!text) throw new Error("Journal is empty");
      return { tool: "append_to_journal", args: { content: text, date } };
    case "todo":
      if (!text) throw new Error("Todo is empty");
      return { tool: "append_to_journal", args: { content: `- [ ] ${text.replace(/\n+/g, "\n  ")}`, date } };
    case "link": {
      const link = linkMarkdown(draft.sourceTitle, draft.sourceUrl);
      // Hepta Markdown uses + for a toggle item and indentation for its children.
      const content = text ? `+ ${link}\n  ${text.replace(/\n/g, "\n  ")}` : `+ ${link}`;
      return { tool: "append_to_journal", args: { content, date } };
    }
    case "note": {
      if (!text) throw new Error("Note is empty");
      const heading = /^#\s/.test(text) ? text : `# ${draft.sourceTitle || "Quick note"}\n\n${text}`;
      const source = /^https?:\/\//i.test(draft.sourceUrl || "")
        ? `\n\nSource: ${linkMarkdown(draft.sourceTitle, draft.sourceUrl)}` : "";
      return { tool: "create_object", args: { objectType: "card", content: `${heading}${source}` } };
    }
  }
}
