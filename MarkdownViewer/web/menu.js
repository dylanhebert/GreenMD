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

  function configure(registry) {
    commands = registry;
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
        item.addEventListener("click", () => { close(); command.run(); });
        list.append(item);
      }

      root.append(button, list);
      barEl.append(root);
    });
  }

  function open(index) {
    openIndex = index;
    [...barEl.querySelectorAll(".menu")].forEach((menu, i) => {
      menu.classList.toggle("open", i === index);
      menu.querySelector(".menu-list").hidden = i !== index;
    });
  }

  function close() {
    openIndex = -1;
    for (const menu of barEl.querySelectorAll(".menu")) {
      menu.classList.remove("open");
      menu.querySelector(".menu-list").hidden = true;
    }
  }

  function toggle(index) {
    if (openIndex === index) close(); else open(index);
  }

  /** Re-reads command state, so an item's enabled look can follow the app. */
  function refresh() {
    if (!barEl || !commands) return;

    for (const item of barEl.querySelectorAll(".menu-item")) {
      const command = commands.get(item.dataset.command);
      item.classList.toggle("unavailable", !!command && command.available && !command.available());
    }
  }

  return { configure, refresh, close, menus: MENUS };
})();
