// Source-mode markdown editor on a contenteditable div: each line is a <div>,
// styled by its markdown prefix (syntax characters stay visible, the stored
// value is always plain markdown). Class toggling never touches text nodes,
// so the caret is left alone.

const LINE_RULES = [
  [/^#\s/, "md-h1"],
  [/^##\s/, "md-h2"],
  [/^#{3,6}\s/, "md-h3"],
  [/^>\s?/, "md-quote"],
  [/^(-|\*|\+|\d+\.)\s/, "md-li"],
];

/** Chrome types the first character of an empty editor as a bare text node; wrap it in a line div. */
export function normalize(root) {
  while (root.firstChild && root.firstChild.nodeType === Node.TEXT_NODE) {
    const textNode = root.firstChild;
    const sel = getSelection();
    const offset = sel.focusNode === textNode ? sel.focusOffset : null;
    const line = document.createElement("div");
    root.replaceChild(line, textNode);
    line.appendChild(textNode);
    if (offset !== null) {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

export function refreshStyles(root) {
  let inFence = false;
  for (const line of root.children) {
    const text = line.textContent;
    let cls = "";
    if (/^```/.test(text)) {
      cls = "md-code md-fence";
      inFence = !inFence;
    } else if (inFence) {
      cls = "md-code";
    } else {
      for (const [re, c] of LINE_RULES) {
        if (re.test(text)) { cls = c; break; }
      }
    }
    if (line.className !== cls) line.className = cls;
  }
}

export function getValue(root) {
  const lines = [];
  for (const node of root.childNodes) {
    lines.push(node.textContent.replace(/\n/g, ""));
  }
  return lines.join("\n");
}

export function setValue(root, text) {
  root.textContent = "";
  for (const lineText of text.split("\n")) {
    const line = document.createElement("div");
    if (lineText) line.textContent = lineText;
    else line.appendChild(document.createElement("br"));
    root.appendChild(line);
  }
  refreshStyles(root);
}
