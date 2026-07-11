// Lightweight rich-source Markdown editor. Each line remains a direct child of
// the contenteditable root. Block syntax can be collapsed visually, but its
// text stays in the DOM so getValue() always returns lossless plain Markdown.

const LINE_RULES = [
  [/^#\s/, "md-h1"],
  [/^##\s/, "md-h2"],
  [/^#{3,6}\s/, "md-h3"],
  [/^>\s?/, "md-quote"],
  [/^(-|\*|\+|\d+\.)\s/, "md-li"],
];

const HEADING_PREFIX = /^(#{1,6}\s)/;
const FENCE_PREFIX = /^(```)/;

function directLine(root, node) {
  while (node && node.parentNode !== root) node = node.parentNode;
  return node?.parentNode === root ? node : null;
}

function textOffset(line, node, offset) {
  const range = document.createRange();
  range.setStart(line, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function captureSelection(root) {
  const sel = getSelection();
  if (!sel?.rangeCount) return null;
  const anchorLine = directLine(root, sel.anchorNode);
  const focusLine = directLine(root, sel.focusNode);
  if (!anchorLine || !focusLine) return null;
  return {
    anchorLine: Array.prototype.indexOf.call(root.children, anchorLine),
    anchorOffset: textOffset(anchorLine, sel.anchorNode, sel.anchorOffset),
    focusLine: Array.prototype.indexOf.call(root.children, focusLine),
    focusOffset: textOffset(focusLine, sel.focusNode, sel.focusOffset),
  };
}

function pointAtTextOffset(line, requestedOffset) {
  const offset = Math.max(0, Math.min(requestedOffset, line.textContent.length));
  const syntax = line.firstElementChild?.classList.contains("md-syntax")
    ? line.firstElementChild
    : null;

  // Keep the caret out of collapsed syntax. A caret logically at the end of a
  // prefix belongs immediately after its span, ready for visible input.
  if (syntax && offset <= syntax.textContent.length) {
    return [line, 1];
  }

  let consumed = 0;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const next = consumed + node.data.length;
    if (offset <= next) return [node, offset - consumed];
    consumed = next;
  }
  return [line, line.childNodes.length];
}

function restoreSelection(root, saved) {
  if (!saved) return;
  const anchorLine = root.children[saved.anchorLine];
  const focusLine = root.children[saved.focusLine];
  if (!anchorLine || !focusLine) return;
  const [anchorNode, anchorOffset] = pointAtTextOffset(anchorLine, saved.anchorOffset);
  const [focusNode, focusOffset] = pointAtTextOffset(focusLine, saved.focusOffset);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}

function syntaxPrefix(text, isFence) {
  const match = (isFence ? FENCE_PREFIX : HEADING_PREFIX).exec(text);
  return match?.[1] ?? "";
}

function renderLine(line, text, cls, prefix) {
  line.className = cls;
  line.replaceChildren();
  if (prefix) {
    const syntax = document.createElement("span");
    syntax.className = "md-syntax";
    syntax.textContent = prefix;
    line.appendChild(syntax);
  }
  const visibleText = text.slice(prefix.length);
  if (visibleText) line.appendChild(document.createTextNode(visibleText));
  else if (!prefix) line.appendChild(document.createElement("br"));
}

/** Chrome can type the first character of an empty editor as a bare text node. */
export function normalize(root) {
  while (root.firstChild && root.firstChild.nodeType === Node.TEXT_NODE) {
    const textNode = root.firstChild;
    const sel = getSelection();
    const anchorOffset = sel.anchorNode === textNode ? sel.anchorOffset : null;
    const focusOffset = sel.focusNode === textNode ? sel.focusOffset : null;
    const line = document.createElement("div");
    root.replaceChild(line, textNode);
    line.appendChild(textNode);
    if (anchorOffset !== null && focusOffset !== null) {
      sel.setBaseAndExtent(textNode, anchorOffset, textNode, focusOffset);
    }
  }
}

/**
 * Keep DOM rendering outside the browser's IME composition transaction.
 * Replacing nodes while composition is active cancels Chinese/Japanese/Korean
 * candidate input in Chromium.
 */
export function bindEditorLifecycle(root, onSettled) {
  let composing = false;

  const settle = () => {
    normalize(root);
    refreshStyles(root);
    onSettled();
  };

  root.addEventListener("compositionstart", () => {
    composing = true;
  });
  root.addEventListener("compositionend", () => {
    composing = false;
    settle();
  });
  root.addEventListener("input", (event) => {
    if (composing || event.isComposing) return;
    settle();
  });

  return {
    isActive(event) {
      return composing || event.isComposing || event.keyCode === 229;
    },
  };
}

export function refreshStyles(root) {
  const saved = captureSelection(root);
  let inFence = false;
  for (const line of root.children) {
    const text = line.textContent.replace(/\n/g, "");
    const isFence = /^```/.test(text);
    let cls = "";
    if (isFence) {
      cls = "md-code md-fence";
    } else if (inFence) {
      cls = "md-code";
    } else {
      for (const [re, candidate] of LINE_RULES) {
        if (re.test(text)) { cls = candidate; break; }
      }
    }
    renderLine(line, text, cls, syntaxPrefix(text, isFence));
    if (isFence) inFence = !inFence;
  }
  restoreSelection(root, saved);
}

export function handleListEnter(root, event) {
  if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const sel = getSelection();
  if (!sel?.isCollapsed) return false;
  const line = directLine(root, sel.focusNode);
  if (!line) return false;

  const text = line.textContent.replace(/\n/g, "");
  const match = /^(\s*)((?:[-*+])|(?:\d+\.))(\s)(.*)$/.exec(text);
  if (!match) return false;
  const prefix = match[1] + match[2] + match[3];
  const caret = textOffset(line, sel.focusNode, sel.focusOffset);
  if (caret < prefix.length) return false;

  event.preventDefault();
  if (match[4] === "") {
    renderLine(line, "", "", "");
    restoreSelection(root, {
      anchorLine: Array.prototype.indexOf.call(root.children, line),
      anchorOffset: 0,
      focusLine: Array.prototype.indexOf.call(root.children, line),
      focusOffset: 0,
    });
    return true;
  }

  const nextMarker = /^\d+\.$/.test(match[2])
    ? `${Number.parseInt(match[2], 10) + 1}.`
    : match[2];
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const nextText = `${match[1]}${nextMarker} ${after}`;
  const nextLine = document.createElement("div");
  line.after(nextLine);
  renderLine(line, before, "md-li", "");
  renderLine(nextLine, nextText, "md-li", "");
  const nextIndex = Array.prototype.indexOf.call(root.children, nextLine);
  const nextOffset = nextText.length - after.length;
  restoreSelection(root, {
    anchorLine: nextIndex,
    anchorOffset: nextOffset,
    focusLine: nextIndex,
    focusOffset: nextOffset,
  });
  return true;
}

export function getValue(root) {
  const lines = [];
  for (const node of root.childNodes) {
    lines.push(node.textContent.replace(/\n/g, ""));
  }
  return lines.join("\n");
}

export function setValue(root, text) {
  root.replaceChildren();
  for (const lineText of text.split("\n")) {
    const line = document.createElement("div");
    renderLine(line, lineText, "", "");
    root.appendChild(line);
  }
  refreshStyles(root);
}
