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
        { command: "openFile" },
        { command: "addFolder" },
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
        { command: "find" }
      ]
    },
    {
      label: "View",
      items: [
        { command: "toggleFiles" },
        { command: "toggleOutline" },
        { command: "swapPanels" },
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
        { command: "find" }
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

    for (const item of barEl.querySelectorAll(".menu-item")) {
      const command = commands.get(item.dataset.command);
      const unavailable = isUnavailable(command);

      item.classList.toggle("unavailable", unavailable);
      item.setAttribute("aria-disabled", String(unavailable));
      item.title = unavailable && command.reason ? command.reason : "";
    }
  }

  return { configure, refresh, close, menus: MENUS, closeGraceMs: CLOSE_GRACE_MS };
})();
