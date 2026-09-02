/* All client-side behavior, delegated from the document so it survives HTMX
 * swaps and works under a strict Content-Security-Policy (no inline JS). */
(function () {
  "use strict";

  // ---- Toast feedback ----
  function toast(message, isError) {
    var region = document.getElementById("toast-region");
    if (!region) return;
    var el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = message;
    region.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  function closeDropdowns(except) {
    document.querySelectorAll(".action-dropdown.open").forEach(function (dd) {
      if (except && dd.contains(except)) return;
      dd.classList.remove("open");
      var toggle = dd.querySelector("[data-dropdown-toggle]");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
  }

  /**
   * Place an open menu next to its toggle. The menu is position:fixed so it
   * escapes the table's scroll container; it flips above the button when there
   * is not enough room below, and is clamped to the viewport horizontally.
   */
  function positionMenu(dropdown, toggle) {
    var menu = dropdown.querySelector(".dropdown-menu");
    if (!menu) return;
    var pad = 8;
    var gap = 2;
    var rect = toggle.getBoundingClientRect();
    var width = menu.offsetWidth;
    var height = menu.offsetHeight;

    var top = rect.bottom + gap;
    if (top + height > window.innerHeight - pad) {
      var above = rect.top - height - gap;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - height - pad);
    }

    var left = rect.right - width;
    if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad;
    if (left < pad) left = pad;

    menu.style.top = top + "px";
    menu.style.left = left + "px";
  }

  function rows() {
    return Array.prototype.slice.call(
      document.querySelectorAll("#books-table tbody tr"),
    );
  }

  function syncSearchClear() {
    var input = document.getElementById("search-input");
    var clear = document.getElementById("search-clear");
    if (input && clear) clear.hidden = input.value.length === 0;
  }

  function applyFilters() {
    var input = document.getElementById("search-input");
    var query = input ? input.value.toLowerCase() : "";
    syncSearchClear();
    rows().forEach(function (row) {
      var matchesSearch = !query || row.dataset.search.indexOf(query) !== -1;
      row.style.display = matchesSearch ? "" : "none";
    });
  }

  // ---- Column visibility + order ----
  // Cached in localStorage for instant, no-flash reapplication on every
  // table refresh, but the account (when there is one) is the durable
  // source of truth — the desktop app binds to a fresh OS-assigned port on
  // every launch, so localStorage alone would reset on every restart. On
  // load, seedColumnPrefsFromServer() overwrites the local cache with
  // whatever the page's initial render says the account has saved; every
  // change after that updates the cache immediately and re-saves to the
  // account in the background.
  var COLUMN_PREFS_KEY = "audible-backup:hidden-columns";

  function getHiddenColumns() {
    try {
      return JSON.parse(localStorage.getItem(COLUMN_PREFS_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function setHiddenColumns(cols) {
    try {
      localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(cols));
    } catch (e) {
      // Private browsing / storage disabled — the toggle still works this load.
    }
  }

  /** Hiding a column via its <col> element is not reliably honored by
   * browsers for the cells within it, so every th/td carrying that column's
   * data-col is toggled directly instead. */
  function applyColumnPrefs() {
    var hidden = getHiddenColumns();
    document.querySelectorAll("#books-table [data-col]").forEach(function (cell) {
      cell.style.display = hidden.indexOf(cell.dataset.col) !== -1 ? "none" : "";
    });
    document.querySelectorAll("[data-col-toggle]").forEach(function (cb) {
      cb.checked = hidden.indexOf(cb.dataset.colToggle) === -1;
    });
  }

  function toggleColumn(key, visible) {
    var hidden = getHiddenColumns();
    var idx = hidden.indexOf(key);
    if (visible && idx !== -1) hidden.splice(idx, 1);
    if (!visible && idx === -1) hidden.push(key);
    setHiddenColumns(hidden);
    applyColumnPrefs();
    persistColumnPrefsToServer();
  }

  /** Fire-and-forget: keeps the account's saved prefs in sync with whatever
   * is now in localStorage. No-ops server-side in legacy mode (no account to
   * attach it to) — localStorage alone is fine there, since that deployment
   * has a stable origin. */
  function persistColumnPrefsToServer() {
    fetch("/api/column-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: getHiddenColumns(), order: getColumnOrder() }),
    }).catch(function () {});
  }

  /** Runs once on page load: the server rendered this account's saved
   * column prefs (if any) into #column-prefs-data. Only overwrite the local
   * cache when the account actually has something saved, so a browser-only
   * choice made before this account had ever saved one isn't stomped on. */
  function seedColumnPrefsFromServer() {
    var el = document.getElementById("column-prefs-data");
    if (!el) return;
    var hidden = el.dataset.hidden ? el.dataset.hidden.split(",").filter(Boolean) : [];
    var order = el.dataset.order ? el.dataset.order.split(",").filter(Boolean) : [];
    if (hidden.length) setHiddenColumns(hidden);
    if (order.length) setColumnOrder(order);
  }

  // ---- Column order (drag the header cells to reorder) ----
  var COLUMN_ORDER_KEY = "audible-backup:column-order";

  /** The column keys in the order the server rendered them — the starting
   * point before any saved preference or drag is applied. */
  function defaultColumnOrder() {
    return Array.prototype.map.call(
      document.querySelectorAll("#books-table thead th[data-col]"),
      function (th) { return th.dataset.col; },
    );
  }

  /** Saved order, but reconciled against the columns that actually exist:
   * unknown (stale) keys are dropped, and any column the saved order doesn't
   * mention (new since the preference was saved) is appended at the end. */
  function getColumnOrder() {
    var saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(COLUMN_ORDER_KEY) || "[]");
    } catch (e) {
      // fall through with an empty saved order
    }
    var natural = defaultColumnOrder();
    var known = saved.filter(function (key) { return natural.indexOf(key) !== -1; });
    var missing = natural.filter(function (key) { return known.indexOf(key) === -1; });
    return known.concat(missing);
  }

  function setColumnOrder(order) {
    try {
      localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(order));
    } catch (e) {
      // Private browsing / storage disabled — the reorder still works this load.
    }
  }

  /** Moves every row's data-col cells (header and body alike) to match
   * `order`, keeping the fixed checkbox column first and Actions column last
   * — those two never move and never appear in `order`. */
  function applyColumnOrder() {
    var order = getColumnOrder();
    var table = document.getElementById("books-table");
    if (!table || !order.length) return;

    var sections = [table.tHead].concat(Array.prototype.slice.call(table.tBodies));
    sections.forEach(function (section) {
      if (!section) return;
      Array.prototype.forEach.call(section.rows, function (row) {
        var byKey = {};
        Array.prototype.forEach.call(row.children, function (cell) {
          if (cell.dataset.col) byKey[cell.dataset.col] = cell;
        });
        // Actions is the last child and carries no data-col, so it stays put
        // as the anchor every dragged cell gets reinserted in front of.
        var anchor = row.lastElementChild;
        order.forEach(function (key) {
          var cell = byKey[key];
          if (cell) row.insertBefore(cell, anchor);
        });
      });
    });
  }

  var dragSrcKey = null;

  document.addEventListener("dragstart", function (e) {
    var th = e.target.closest("#books-table thead th[data-col]");
    if (!th) return;
    dragSrcKey = th.dataset.col;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragSrcKey);
    th.classList.add("dragging");
  });

  document.addEventListener("dragend", function (e) {
    var th = e.target.closest("#books-table thead th[data-col]");
    if (th) th.classList.remove("dragging");
    document.querySelectorAll("#books-table thead th.drag-over").forEach(function (el) {
      el.classList.remove("drag-over");
    });
    dragSrcKey = null;
  });

  document.addEventListener("dragover", function (e) {
    if (!dragSrcKey) return;
    var th = e.target.closest("#books-table thead th[data-col]");
    if (!th) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (th.dataset.col !== dragSrcKey) th.classList.add("drag-over");
  });

  document.addEventListener("dragleave", function (e) {
    var th = e.target.closest("#books-table thead th[data-col]");
    if (th) th.classList.remove("drag-over");
  });

  document.addEventListener("drop", function (e) {
    if (!dragSrcKey) return;
    var th = e.target.closest("#books-table thead th[data-col]");
    if (!th) return;
    e.preventDefault();
    th.classList.remove("drag-over");
    var targetKey = th.dataset.col;
    if (targetKey === dragSrcKey) return;

    var order = getColumnOrder();
    var from = order.indexOf(dragSrcKey);
    var to = order.indexOf(targetKey);
    if (from === -1 || to === -1) return;
    order.splice(from, 1);
    order.splice(to, 0, dragSrcKey);
    setColumnOrder(order);
    applyColumnOrder();
    persistColumnPrefsToServer();
  });

  // ---- Download Selected: only actionable once something is checked ----
  function updateDownloadSelectedState() {
    var btn = document.getElementById("download-selected-btn");
    if (!btn || btn.hasAttribute("data-cancel")) return;
    btn.disabled = !document.querySelector('input[name="asin"]:checked');
  }

  var statusOrder = {
    "not-downloaded": 0, "not-downloadable": 1, "convertible": 2,
    "downloaded": 3, "converted": 4, "ignored": 5,
  };

  function sortBy(th) {
    // The cell's live position, not a value baked in at render time — columns
    // can be dragged to a new position, and this stays correct either way.
    var col = th.cellIndex;
    var type = th.dataset.sortType;
    var dir = th.classList.contains("asc") ? "desc" : "asc";

    document.querySelectorAll("th.sortable").forEach(function (h) {
      h.classList.remove("asc", "desc");
      h.removeAttribute("aria-sort");
    });
    th.classList.add(dir);
    th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");

    var tbody = document.querySelector("#books-table tbody");
    if (!tbody) return;
    var sorted = rows().sort(function (a, b) {
      var aVal = (a.children[col] && a.children[col].dataset.sortVal) || "";
      var bVal = (b.children[col] && b.children[col].dataset.sortVal) || "";
      var cmp;
      if (type === "number") {
        cmp = (parseFloat(aVal) || 0) - (parseFloat(bVal) || 0);
      } else if (type === "status") {
        cmp = (statusOrder[aVal] !== undefined ? statusOrder[aVal] : 99) -
              (statusOrder[bVal] !== undefined ? statusOrder[bVal] : 99);
      } else {
        cmp = aVal.localeCompare(bVal);
      }
      return dir === "asc" ? cmp : -cmp;
    });
    sorted.forEach(function (row) { tbody.appendChild(row); });
    applyFilters();
  }

  // ---- Settings: conversion format/quality ----
  // The preset/format buttons mutate the visible args field directly; the
  // checkbox only controls whether that field also accepts direct typing.
  function audioPresetsData() {
    var el = document.getElementById("audio-presets-data");
    if (!el) return null;
    try {
      return {
        presets: JSON.parse(el.dataset.presets || "{}"),
        estimates: JSON.parse(el.dataset.estimates || "{}"),
      };
    } catch (e) {
      return null;
    }
  }

  function selectAudioButton(groupSelector, value) {
    document.querySelectorAll(groupSelector).forEach(function (btn) {
      var active = (btn.dataset.audioFormat || btn.dataset.audioQuality) === value;
      btn.classList.toggle("btn-primary", active);
      btn.classList.toggle("btn-ghost", !active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  function updateAudioArgsDisplay() {
    var data = audioPresetsData();
    var argsInput = document.getElementById("audio-args");
    var formatInput = document.getElementById("audio-format-input");
    var qualityInput = document.getElementById("audio-quality-input");
    if (!data || !argsInput || !formatInput || !qualityInput) return;
    var byFormat = data.presets[formatInput.value];
    argsInput.value = (byFormat && byFormat[qualityInput.value]) || "";
  }

  function updateQualityTooltips(format) {
    var data = audioPresetsData();
    if (!data) return;
    var byFormat = data.estimates[format];
    if (!byFormat) return;
    document.querySelectorAll("[data-audio-quality]").forEach(function (btn) {
      var estimate = byFormat[btn.dataset.audioQuality];
      if (estimate) btn.title = estimate;
    });
  }

  function setAudioFormat(format) {
    selectAudioButton("[data-audio-format]", format);
    var input = document.getElementById("audio-format-input");
    if (input) input.value = format;
    updateQualityTooltips(format);
    updateAudioArgsDisplay();
  }

  function setAudioQuality(quality) {
    selectAudioButton("[data-audio-quality]", quality);
    var input = document.getElementById("audio-quality-input");
    if (input) input.value = quality;
    updateAudioArgsDisplay();
  }

  // ---- Delegated events ----
  // Capture phase: a button turned into "Cancel" still carries its original
  // hx-post, so stop the event before htmx's own listener sees it.
  document.addEventListener("click", function (e) {
    var cancelBtn = e.target.closest("[data-cancel]");
    if (!cancelBtn) return;
    e.preventDefault();
    e.stopPropagation();
    cancelBtn.disabled = true;
    fetch("/operation/cancel", { method: "POST" }).catch(function (err) {
      toast("Could not cancel: " + err.message, true);
    });
  }, true);

  document.addEventListener("click", function (e) {
    if (e.target.closest("#log-toggle")) {
      var open = !isLogOpen();
      setLogOpen(open);
      if (open) setIndicator(document.body.classList.contains("op-running") ? "running" : null);
      return;
    }
    if (e.target.closest("#log-float-close")) {
      setLogOpen(false);
      return;
    }

    // Remember which control started an operation so it can become Cancel.
    var trigger = e.target.closest("button[hx-post]");
    if (trigger && !trigger.hasAttribute("data-cancel")) activeTrigger = trigger;

    var toggle = e.target.closest("[data-dropdown-toggle]");
    if (toggle) {
      var dd = toggle.closest(".action-dropdown");
      var willOpen = !dd.classList.contains("open");
      closeDropdowns();
      if (willOpen) {
        dd.classList.add("open");
        toggle.setAttribute("aria-expanded", "true");
        positionMenu(dd, toggle);
      }
      return;
    }

    var formatBtn = e.target.closest("[data-audio-format]");
    if (formatBtn) {
      setAudioFormat(formatBtn.dataset.audioFormat);
      return;
    }
    var qualityBtn = e.target.closest("[data-audio-quality]");
    if (qualityBtn) {
      setAudioQuality(qualityBtn.dataset.audioQuality);
      return;
    }

    closeDropdowns(e.target);

    var actionBtn = e.target.closest("[data-action-url]");
    if (actionBtn) {
      var confirmMsg = actionBtn.dataset.confirm;
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      actionBtn.disabled = true;
      fetch(actionBtn.dataset.actionUrl, { method: "POST" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          if (actionBtn.dataset.reload === "true") location.reload();
          else document.body.dispatchEvent(new CustomEvent("refresh-books"));
        })
        .catch(function (err) { toast("Action failed: " + err.message, true); })
        .finally(function () { actionBtn.disabled = false; });
      return;
    }

    if (e.target.closest("#search-clear")) {
      var searchInput = document.getElementById("search-input");
      if (searchInput) {
        searchInput.value = "";
        applyFilters();
        searchInput.focus();
      }
      return;
    }

    var th = e.target.closest("th.sortable");
    if (th) sortBy(th);

  });

  // Confirmation for destructive form submissions (data-confirm on the form).
  document.addEventListener("submit", function (e) {
    var message = e.target instanceof HTMLElement && e.target.dataset.confirm;
    if (message && !window.confirm(message)) e.preventDefault();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDropdowns();
  });

  // A fixed menu would drift away from its button once anything scrolls or the
  // viewport changes, so close instead of chasing it. Capture phase catches
  // scrolling inside the table container too.
  document.addEventListener("scroll", function () { closeDropdowns(); }, true);
  window.addEventListener("resize", function () { closeDropdowns(); });

  document.addEventListener("input", function (e) {
    if (e.target.id === "search-input") applyFilters();
  });

  document.addEventListener("change", function (e) {
    if (e.target.id === "select-all") {
      rows().forEach(function (row) {
        if (row.style.display !== "none") {
          var cb = row.querySelector('input[name="asin"]');
          if (cb) cb.checked = e.target.checked;
        }
      });
      updateDownloadSelectedState();
      return;
    }
    if (e.target.name === "asin") {
      updateDownloadSelectedState();
      return;
    }
    if (e.target.dataset.colToggle) {
      toggleColumn(e.target.dataset.colToggle, e.target.checked);
      return;
    }
    if (e.target.id === "audio-custom-toggle") {
      var argsInput = document.getElementById("audio-args");
      if (argsInput) {
        argsInput.disabled = !e.target.checked;
        if (e.target.checked) argsInput.focus();
      }
    }
  });

  // ---- Operation log panel ----
  // The panel stays closed until the user opens it from the topbar; a running
  // or finished operation only lights up the indicator on that button.
  var activeTrigger = null;

  function logFloat() { return document.getElementById("log-float"); }

  function setIndicator(state) {
    var dot = document.getElementById("log-indicator");
    if (!dot) return;
    dot.classList.remove("running", "done", "failed");
    if (!state) {
      dot.hidden = true;
      return;
    }
    dot.hidden = false;
    dot.classList.add(state);
  }

  function setLogOpen(open) {
    var panel = logFloat();
    var toggle = document.getElementById("log-toggle");
    if (!panel) return;
    panel.classList.toggle("visible", open);
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      var body = document.getElementById("progress-panel");
      if (body) body.scrollTop = body.scrollHeight;
    }
  }

  function isLogOpen() {
    var panel = logFloat();
    return !!panel && panel.classList.contains("visible");
  }

  /** Only one operation runs at a time, so every other trigger is disabled. */
  function setOperationRunning(running) {
    document.body.classList.toggle("op-running", running);
    document.querySelectorAll("button[hx-post]").forEach(function (button) {
      if (button === activeTrigger) return;
      button.disabled = running;
    });
    // The blanket re-enable above ignores selection state — reassert it.
    updateDownloadSelectedState();

    if (!activeTrigger) return;
    // An icon-only button (e.g. Sync Library) keeps its icon rather than
    // losing it to the word "Cancel" — CSS spins the icon in place while
    // [data-cancel] is set, and swaps it for a red X on hover. Only its
    // accessible name changes, so screen readers still hear "cancel".
    var iconOnly = activeTrigger.classList.contains("btn-icon");
    if (running) {
      activeTrigger.setAttribute("data-cancel", "true");
      activeTrigger.disabled = false;
      if (iconOnly) {
        if (activeTrigger.dataset.originalAriaLabel === undefined) {
          activeTrigger.dataset.originalAriaLabel = activeTrigger.getAttribute("aria-label") || "";
        }
        activeTrigger.setAttribute("aria-label", "Cancel " + activeTrigger.dataset.originalAriaLabel.toLowerCase());
      } else {
        if (!activeTrigger.dataset.originalLabel) {
          activeTrigger.dataset.originalLabel = activeTrigger.innerHTML;
        }
        activeTrigger.innerHTML = "Cancel";
        activeTrigger.classList.add("btn-danger");
      }
    } else {
      activeTrigger.removeAttribute("data-cancel");
      activeTrigger.disabled = false;
      if (activeTrigger.dataset.originalAriaLabel !== undefined) {
        activeTrigger.setAttribute("aria-label", activeTrigger.dataset.originalAriaLabel);
        delete activeTrigger.dataset.originalAriaLabel;
      }
      if (activeTrigger.dataset.originalLabel) {
        activeTrigger.innerHTML = activeTrigger.dataset.originalLabel;
        delete activeTrigger.dataset.originalLabel;
      }
      activeTrigger.classList.remove("btn-danger");
      activeTrigger = null;
    }
  }

  var progressPanel = document.getElementById("progress-panel");
  if (progressPanel) {
    new MutationObserver(function () {
      if (progressPanel.children.length > 0) {
        setOperationRunning(true);
        if (!isLogOpen()) setIndicator("running");
      }
    }).observe(progressPanel, { childList: true });
  }

  document.addEventListener("htmx:sseMessage", function (e) {
    var panel = e.target.closest(".log-panel");
    if (panel) {
      requestAnimationFrame(function () { panel.scrollTop = panel.scrollHeight; });
    }
  });

  // When an operation finishes: start the prepared download (if the server
  // asked for one), release the buttons, then refresh the books table.
  document.body.addEventListener("htmx:sseClose", function () {
    var marker = document.getElementById("op-download");
    var url = marker && marker.getAttribute("data-download-url");
    if (url) {
      marker.removeAttribute("data-download-url");
      var a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    setOperationRunning(false);
    var failed = !!document.querySelector("#progress-panel .log-done.error");
    setIndicator(isLogOpen() ? null : failed ? "failed" : "done");
    document.body.dispatchEvent(new CustomEvent("refresh-books"));
  });

  // The search box and Download Selected button live in the topbar, outside
  // the swapped `.library-layout`, so the search box survives a books-table
  // refresh on its own — it just needs its filter (and the fresh rows'
  // column visibility and selection state) reapplied.
  document.body.addEventListener("htmx:afterSwap", function () {
    applyFilters();
    applyColumnPrefs();
    applyColumnOrder();
    updateDownloadSelectedState();
    if (document.body.classList.contains("op-running")) {
      document.querySelectorAll("button[hx-post]").forEach(function (button) {
        if (button !== activeTrigger) button.disabled = true;
      });
    }
  });

  // Initial page load: sync the local cache from the account's saved prefs
  // (if any), apply them, and set up the (unchecked) selection state — the
  // server always renders every column shown, in its default order.
  seedColumnPrefsFromServer();
  applyColumnPrefs();
  applyColumnOrder();
  updateDownloadSelectedState();
})();
