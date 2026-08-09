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
      document.querySelectorAll("#books-table tbody tr[data-status]"),
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
    var active = {};
    document.querySelectorAll(".filter-btn.active[data-status]").forEach(function (btn) {
      active[btn.dataset.status] = true;
    });
    rows().forEach(function (row) {
      var matchesSearch = !query || row.dataset.search.indexOf(query) !== -1;
      var matchesFilter = !!active[row.dataset.status];
      row.style.display = matchesSearch && matchesFilter ? "" : "none";
    });
  }

  var statusOrder = {
    "not-downloaded": 0, "not-downloadable": 1, "convertible": 2,
    "downloaded": 3, "converted": 4, "ignored": 5,
  };

  function sortBy(th) {
    var col = parseInt(th.dataset.sortCol, 10);
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

    var pill = e.target.closest(".filter-btn[data-status]");
    if (pill) {
      pill.classList.toggle("active");
      pill.setAttribute("aria-pressed", String(pill.classList.contains("active")));
      applyFilters();
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

    if (!activeTrigger) return;
    if (running) {
      if (!activeTrigger.dataset.originalLabel) {
        activeTrigger.dataset.originalLabel = activeTrigger.innerHTML;
      }
      activeTrigger.innerHTML = "Cancel";
      activeTrigger.classList.add("btn-danger");
      activeTrigger.setAttribute("data-cancel", "true");
      activeTrigger.disabled = false;
    } else {
      if (activeTrigger.dataset.originalLabel) {
        activeTrigger.innerHTML = activeTrigger.dataset.originalLabel;
        delete activeTrigger.dataset.originalLabel;
      }
      activeTrigger.classList.remove("btn-danger");
      activeTrigger.removeAttribute("data-cancel");
      activeTrigger.disabled = false;
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

  // Preserve the search box across table refreshes.
  var savedSearch = "";
  document.body.addEventListener("htmx:beforeSwap", function () {
    var input = document.getElementById("search-input");
    if (input) savedSearch = input.value;
  });
  document.body.addEventListener("htmx:afterSwap", function () {
    var input = document.getElementById("search-input");
    if (input && savedSearch) {
      input.value = savedSearch;
      applyFilters();
    }
    if (document.body.classList.contains("op-running")) {
      document.querySelectorAll("button[hx-post]").forEach(function (button) {
        if (button !== activeTrigger) button.disabled = true;
      });
    }
  });
})();
