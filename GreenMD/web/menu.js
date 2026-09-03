"use strict";

/**
 * The menu bar.
 *
 * Exists so that nothing is reachable only by keyboard. It is built from the same
 * command registry the shortcuts use, so a command cannot gain a key binding without
 * also gaining a menu entry — the two cannot drift apart because there is only one
 * list.
 */
window.Menu = (() => {

  let barEl = null;
  let commands = null;
  let openIndex = -1;
  let hooks = {};

  /** [{ label, items: [{ command } | { separator: true }] }] */
  const MENUS = [
    {
      label: "File",
      items: [
        { command: "newFile" },
        { command: "openFile" },
        { command: "addFolder" },
        { separator: true },
        { recent: true },
        { separator: true },
        { command: "save" },
        { separator: true },
        { command: "closeTab" },
        { command: "closeFolders" },
        { separator: true },
        { command: "registerAssociation" }
      ]
    },
    {
      label: "Edit",
      items: [
        { command: "toggleSource" },
        { command: "save" },
        { separator: true },
        { command: "find" },
        { separator: true },
        { command: "clearChangeMarks" },
        { command: "markAllChangesSeen" }
      ]
    },
    {
      label: "View",
      items: [
        { command: "toggleFiles" },
        { command: "toggleOutline" },
        { command: "toggleChangeMarks" },
        { command: "swapPanels" },
        { separator: true },
        { command: "toggleDocMap" },
        { command: "cycleDocMapStyle" },
        { separator: true },
        { command: "resetPaneWidths" },
        { separator: true },
        { command: "zoomIn" },
        { command: "zoomOut" },
        { command: "zoomReset" }
      ]
    },
    {
      label: "Panes",
      items: [
        { command: "splitRight" },
        { command: "splitDown" },
        { separator: true },
        { command: "nextTab" },
        { command: "prevTab" }
      ]
    },
    {
      label: "Go",
      items: [
        { command: "goToFile" },
        { command: "find" },
        { separator: true },
        { command: "nextChanged" }
      ]
    },
    {
      label: "Help",
      items: [
        { command: "about" }
      ]
    }
  ];

  function configure(registry, options) {
    commands = registry;
    hooks = options || {};
    barEl = document.getElementById("menubar");
    render();

    // A click anywhere else closes whatever is open.
    document.addEventListener("mousedown", event => {
      if (!barEl.contains(event.target)) close();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && openIndex >= 0) { close(); event.stopPropagation(); }
    });
  }

  function render() {
    barEl.replaceChildren();

    MENUS.forEach((menu, index) => {
      const root = document.createElement("div");
      root.className = "menu";

      // Leaving an open menu closes it, but only after a grace period: moving
      // diagonally from the title to an item near the edge of the list can leave the
      // element for a frame, and snapping shut on that is maddening.
      root.addEventListener("mouseenter", cancelPendingClose);
      root.addEventListener("mouseleave", scheduleClose);

      const button = document.createElement("button");
      button.className = "menu-title";
      button.type = "button";
      button.textContent = menu.label;
      button.addEventListener("click", () => toggle(index));
      // Once one menu is open, hovering across the bar switches between them.
      button.addEventListener("mouseenter", () => { if (openIndex >= 0) open(index); });

      const list = document.createElement("div");
      list.className = "menu-list";
      list.hidden = true;

      for (const entry of menu.items) {
        if (entry.separator) {
          const rule = document.createElement("div");
          rule.className = "menu-separator";
          list.append(rule);
          continue;
        }

        // Recent files are data, not commands, so they cannot come out of the registry
        // like everything else here. This leaves a container that renderRecent fills
        // and refills -- the list changes every time a document is opened, and
        // rebuilding just this part leaves the rest of the bar untouched.
        if (entry.recent) {
          const holder = document.createElement("div");
          holder.className = "menu-recent";
          list.append(holder);
          continue;
        }

        const command = commands.get(entry.command);
        if (!command) continue;

        const item = document.createElement("button");
        item.className = "menu-item";
        item.type = "button";
        item.dataset.command = entry.command;

        const label = document.createElement("span");
        label.textContent = command.label;

        const keys = document.createElement("span");
        keys.className = "menu-keys";
        keys.textContent = command.keys || "";

        item.append(label, keys);

        // A greyed item that runs anyway is worse than one that does nothing, and one
        // that does nothing silently is worse still. Clicking says why instead.
        item.addEventListener("click", () => {
          close();
          if (isUnavailable(command)) {
            if (hooks.onUnavailable) hooks.onUnavailable(command);
            return;
          }
          command.run();
        });

        list.append(item);
      }

      root.append(button, list);
      barEl.append(root);
    });

    renderRecent();
  }

  // Written with String.fromCharCode rather than an escape: backslashes in these files
  // have been mangled by tooling before, and a silently broken path split would show up
  // as full paths in the menu rather than as an error.
  const BACKSLASH = String.fromCharCode(92);
  const RECENT_SHOWN = 10;

  function lastCut(path) {
    return Math.max(path.lastIndexOf("/"), path.lastIndexOf(BACKSLASH));
  }

  function fileNameOf(path) {
    const cut = lastCut(path);
    const name = cut >= 0 ? path.slice(cut + 1) : path;
    // The same trailing-.md rule the tabs and the Files panel apply.
    return /\.md$/i.test(name) ? name.slice(0, -3) : name;
  }

  function folderNameOf(path) {
    const cut = lastCut(path);
    if (cut < 0) return "";

    const parent = path.slice(0, cut);
    const up = lastCut(parent);
    return up >= 0 ? parent.slice(up + 1) : parent;
  }

  /**
   * Fills the recent-files section. The stored list is longer than this shows, because
   * Ctrl+P uses the same list as its fallback and wants the depth; a dropdown does not.
   */
  function renderRecent() {
    if (!barEl) return;

    const paths = (hooks.recentFiles ? hooks.recentFiles() : null) || [];

    for (const holder of barEl.querySelectorAll(".menu-recent")) {
      holder.replaceChildren();

      if (paths.length === 0) {
        // A greyed row rather than an empty gap between two separators, which reads as
        // a rendering fault rather than as a feature waiting for its first document.
        const empty = document.createElement("div");
        empty.className = "menu-item unavailable";
        empty.setAttribute("aria-disabled", "true");

        const label = document.createElement("span");
        label.textContent = "No recent files";
        empty.append(label);
        holder.append(empty);
        continue;
      }

      for (const path of paths.slice(0, RECENT_SHOWN)) {
        const item = document.createElement("button");
        item.className = "menu-item";
        item.type = "button";
        item.dataset.recentPath = path;
        item.title = path;

        const label = document.createElement("span");
        label.textContent = fileNameOf(path);

        // Reuses the shortcut column, already dim and right-aligned. Without it two
        // files both called README.md are indistinguishable.
        const where = document.createElement("span");
        where.className = "menu-keys";
        where.textContent = folderNameOf(path);

        item.append(label, where);
        item.addEventListener("click", () => {
          close();
          if (hooks.onOpenRecent) hooks.onOpenRecent(path);
        });

        holder.append(item);
      }
    }
  }

  const CLOSE_GRACE_MS = 260;
  let closeTimer = null;

  function scheduleClose() {
    if (openIndex < 0) return;
    cancelPendingClose();
    closeTimer = setTimeout(() => { closeTimer = null; close(); }, CLOSE_GRACE_MS);
  }

  function cancelPendingClose() {
    if (closeTimer === null) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  function open(index) {
    cancelPendingClose();
    openIndex = index;
    [...barEl.querySelectorAll(".menu")].forEach((menu, i) => {
      menu.classList.toggle("open", i === index);
      menu.querySelector(".menu-list").hidden = i !== index;
    });
  }

  function close() {
    cancelPendingClose();
    openIndex = -1;
    for (const menu of barEl.querySelectorAll(".menu")) {
      menu.classList.remove("open");
      menu.querySelector(".menu-list").hidden = true;
    }
  }

  function toggle(index) {
    if (openIndex === index) close(); else open(index);
  }

  function isUnavailable(command) {
    return !!command && typeof command.available === "function" && !command.available();
  }

  /**
   * Re-reads command state so each item's look follows the app.
   *
   * The second argument to classList.toggle has to be a real boolean. Passing
   * undefined -- which is what `command.available && ...` yields for a command that
   * has no availability rule -- makes toggle ignore the argument and flip the class
   * instead. That is why items which are always available, like "Open file", were
   * showing greyed: they were flipping state on every refresh.
   */
  function refresh() {
    if (!barEl || !commands) return;

    // Scoped to items that came from the registry. Recent-file rows are .menu-item too,
    // and sweeping them into this loop clears the tooltip holding their full path and
    // strips the greyed class off the empty-list row -- they have no data-command, so
    // every lookup here would miss and then overwrite.
    for (const item of barEl.querySelectorAll(".menu-item[data-command]")) {
      const command = commands.get(item.dataset.command);
      const unavailable = isUnavailable(command);

      item.classList.toggle("unavailable", unavailable);
      item.setAttribute("aria-disabled", String(unavailable));
      item.title = unavailable && command.reason ? command.reason : "";
    }

    renderRecent();
  }

  return { configure, refresh, close, menus: MENUS, closeGraceMs: CLOSE_GRACE_MS };
})();
