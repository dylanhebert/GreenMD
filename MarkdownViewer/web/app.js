"use strict";

const host = window.chrome && window.chrome.webview;
const docEl = document.getElementById("doc");
const outlineEl = document.getElementById("outline");

function post(type, payload) {
  host.postMessage({ type, payload: payload ?? null });
}

function renderOutline(headings) {
  outlineEl.replaceChildren();
  for (const h of headings) {
    if (h.level > 4) continue;
    const a = document.createElement("a");
    a.href = "#" + h.id;
    a.dataset.level = String(h.level);
    a.textContent = h.text;
    a.title = h.text;
    outlineEl.append(a);
  }
}

/** Copy buttons are worth more than usual here -- these docs are full of commands. */
function addCopyButtons(root) {
  for (const pre of root.querySelectorAll("pre")) {
    const button = document.createElement("button");
    button.className = "copy";
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      try {
        await navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Failed";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    });
    pre.append(button);
  }
}

function renderDoc(payload) {
  document.title = payload.title || "MarkdownViewer";
  docEl.innerHTML = payload.html;
  HL.highlightAll(docEl);
  addCopyButtons(docEl);
  renderOutline(payload.outline || []);
  docEl.scrollTop = 0;
}

host.addEventListener("message", (event) => {
  const { type, payload } = event.data;
  if (type === "doc") renderDoc(payload);
});

// Outline clicks scroll within the doc pane rather than navigating.
outlineEl.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
});

post("ready");
