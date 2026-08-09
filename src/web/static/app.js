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

  function applyFilters() {
    var input = document.getElementById("search-input");
    var query = input ? input.value.toLowerCase() : "";
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
  document.addEventListener("click", function (e) {
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

    var pill = e.target.closest(".filter-btn[data-status]");
    if (pill) {
      pill.classList.toggle("active");
      pill.setAttribute("aria-pressed", String(pill.classList.contains("active")));
      applyFilters();
      return;
    }

    var th = e.target.closest("th.sortable");
    if (th) sortBy(th);

    if (e.target.closest("#log-float-minimize")) {
      var logFloat = document.getElementById("log-float");
      if (logFloat) logFloat.classList.toggle("minimized");
    }
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

  // ---- Floating log panel ----
  var progressPanel = document.getElementById("progress-panel");
  var logFloat = document.getElementById("log-float");
  if (progressPanel && logFloat) {
    new MutationObserver(function () {
      if (progressPanel.children.length > 0 && !logFloat.classList.contains("visible")) {
        logFloat.classList.add("visible");
      }
    }).observe(progressPanel, { childList: true });
  }

  document.addEventListener("htmx:sseMessage", function (e) {
    var panel = e.target.closest(".log-panel");
    if (panel) {
      requestAnimationFrame(function () { panel.scrollTop = panel.scrollHeight; });
    }
  });

  // When an operation finishes, refresh the books table in place.
  document.body.addEventListener("htmx:sseClose", function () {
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
  });
})();
