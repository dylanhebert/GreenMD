"use strict";

/**
 * Plain-text editing.
 *
 * A textarea, not a code editor. That is a deliberate limit: a real editor component
 * would be the first third-party JavaScript in the app, and this covers what it is
 * actually for — fixing a line in a document you are already reading.
 *
 * Edit state is keyed by pane *and* path, so the same file can be open as source in
 * one pane and rendered in another. Saving updates the rendered pane, which gives a
 * side-by-side live preview without any code specifically for that.
 */
window.Editor = (() => {

  const buffers = new Map();   // "paneId::path" -> { base, text, loaded, staleOnDisk }
  let hooks = {};

  function configure(next) { hooks = next || {}; }

  const keyOf = (paneId, path) => paneId + "::" + path;

  function buffer(paneId, path) {
    const key = keyOf(paneId, path);
    if (!buffers.has(key)) {
      buffers.set(key, { base: "", text: "", loaded: false, staleOnDisk: false });
    }
    return buffers.get(key);
  }

  function isDirty(paneId, path) {
    const key = keyOf(paneId, path);
    const entry = buffers.get(key);
    return !!entry && entry.loaded && entry.text !== entry.base;
  }

  /** True if any buffer for this path, in any pane, has unsaved changes. */
  function isPathDirty(path) {
    for (const [key, entry] of buffers) {
      if (!key.endsWith("::" + path)) continue;
      if (entry.loaded && entry.text !== entry.base) return true;
    }
    return false;
  }

  function isStale(paneId, path) {
    const entry = buffers.get(keyOf(paneId, path));
    return !!entry && entry.staleOnDisk;
  }

  /** Called when the host delivers the source text for a path. */
  function receiveText(path, text) {
    for (const [key, entry] of buffers) {
      if (!key.endsWith("::" + path)) continue;

      if (entry.loaded && entry.text !== entry.base) {
        // Unsaved work in this buffer: record that disk moved on, do not overwrite.
        entry.base = text;
        entry.staleOnDisk = true;
        continue;
      }

      entry.base = text;
      entry.text = text;
      entry.loaded = true;
      entry.staleOnDisk = false;
    }

    if (hooks.onTextArrived) hooks.onTextArrived(path);
  }

  function setText(paneId, path, text) {
    const entry = buffer(paneId, path);
    entry.text = text;
    entry.loaded = true;
  }

  function textOf(paneId, path) {
    const entry = buffers.get(keyOf(paneId, path));
    return entry && entry.loaded ? entry.text : null;
  }

  /** Marks a buffer saved. Called once the host confirms the write landed. */
  function markSaved(path) {
    for (const [key, entry] of buffers) {
      if (!key.endsWith("::" + path)) continue;
      entry.base = entry.text;
      entry.staleOnDisk = false;
    }
  }

  /** A live reload happened: clean buffers take the new text, dirty ones are flagged. */
  function noteExternalChange(path) {
    let needsText = false;

    for (const [key, entry] of buffers) {
      if (!key.endsWith("::" + path)) continue;
      if (!entry.loaded) continue;

      if (entry.text === entry.base) needsText = true;
      else entry.staleOnDisk = true;
    }

    return needsText;
  }

  function forget(paneId, path) {
    buffers.delete(keyOf(paneId, path));
  }

  return {
    configure, buffer, isDirty, isPathDirty, isStale,
    receiveText, setText, textOf, markSaved, noteExternalChange, forget
  };
})();
