// ==UserScript==
// @name         GitHub PR — single file at a time
// @namespace    https://github.com/Wouter8/gh-pr-single-file
// @version      0.9.0
// @description  Bitbucket-style one-file-at-a-time review UX for GitHub PR Files-changed pages
// @author       Wouter van Acht
// @homepageURL  https://github.com/Wouter8/gh-pr-single-file
// @supportURL   https://github.com/Wouter8/gh-pr-single-file/issues
// @updateURL    https://raw.githubusercontent.com/Wouter8/gh-pr-single-file/main/src/github-pr-single-file.user.js
// @downloadURL  https://raw.githubusercontent.com/Wouter8/gh-pr-single-file/main/src/github-pr-single-file.user.js
// We deliberately keep @match broad — Tampermonkey's matcher doesn't always
// honour query strings the way Chrome's spec suggests, and GitHub appends
// flags like ?new_files_changed=true. The internal isFilesPage() regex
// narrows the actual run condition to /files or /changes paths.
// @match        https://github.com/*/pull/*
// @match        https://github.com/*/pull/*/*
// @include      /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/[^?#]*)?(?:[?#].*)?$/
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // See src/SELECTORS.md for evidence and stability notes on every selector
  // referenced here. Update both files together when GitHub changes its DOM.
  //
  // GitHub serves two distinct UI variants for /pull/N/files (which redirects
  // to /pull/N/changes for logged-in users):
  //
  //   New UI (Jan 2026, logged-in default):
  //     [data-testid="progressive-diffs-list"] > div > [id^="diff-"][data-targeted]
  //   Old UI (logged-out / older flag, served as classic Stimulus markup):
  //     copilot-diff-entry > div.file.js-file[id^="diff-"]
  //
  // We try the new UI selectors first since that's where logged-in users land.
  var SELECTORS = {
    fileWrappers: [
      // New UI: the `[id^="diff-"][data-targeted]` div is the file diff itself.
      // Its parent is a CSS-module-hashed wrapper with a single child, so
      // hiding the diff div collapses the parent visually.
      '[id^="diff-"][data-targeted]',
      // Old UI fallbacks (also useful if a future deploy reverts).
      'copilot-diff-entry',
      '[data-targets="diff-file-filter.diffEntries"]',
      'div.file.js-file[id^="diff-"]'
    ],
    innerDiffId: '[id^="diff-"]'
  };

  var STYLE_ID = 'ghpr-style';
  var DATA_ATTR = 'data-ghpr-hidden';
  var VIEWED_ATTR = 'data-ghpr-viewed';
  var TOGGLE_ID = 'ghpr-single-file-toggle';
  var TOGGLE_INPUT_ID = 'ghpr-single-file-toggle-input';
  var COLLAPSE_BTN_ID = 'ghpr-collapse-all-btn';
  var STORAGE_KEY = 'ghpr-single-file-disabled';

  // ── API surface ───────────────────────────────────────────────────────────
  // Set up the api object regardless of which PR sub-page we landed on. The
  // script may be loaded on /pull/N (Conversation tab), then activated when
  // the user navigates to /pull/N/files via Turbo / pushState — that nav
  // doesn't reload the page, so the userscript only ever gets to run once.
  // We use that one run to wire up listeners that *react* to URL changes.
  var api = (typeof window !== 'undefined' ? (window.__ghPrSingleFile = window.__ghPrSingleFile || {}) : {});
  api.loaded = true;
  api.version = '0.9.0';
  api.applyVisibility = applyVisibility;
  api.syncViewedDecorations = syncViewedDecorations;
  api.getFileWrappers = getFileWrappers;
  api.getCurrentTargetId = getCurrentTargetId;
  api.isDisabled = function () { return !!api.disabled; };
  api.setDisabled = setDisabled;
  api.toggleDisabled = function () { setDisabled(!api.disabled); };
  api.isActive = function () { return !!api.active; };

  api.disabled = readPersistedDisabled();

  // ── Always-on URL-change listeners ────────────────────────────────────────
  // GitHub's PR pages use a mix of Turbo (pjax-style swaps) and React
  // pushState/replaceState. Each navigation kind fires a different signal —
  // we listen to all of them and let onUrlChange() decide whether we should
  // be active on the new URL.
  window.addEventListener('hashchange', onUrlChange);
  window.addEventListener('popstate', onUrlChange);
  document.addEventListener('turbo:load', onUrlChange);
  document.addEventListener('turbo:render', onUrlChange);
  document.addEventListener('turbo:frame-load', onUrlChange);
  document.addEventListener('pjax:end', onUrlChange);
  patchHistoryMethods();
  // Last-resort poll: covers exotic SPA routing patterns we haven't seen yet,
  // plus catches the case where the URL changes without firing any event we
  // hooked.
  var lastSeenUrl = location.href;
  setInterval(function () {
    if (location.href !== lastSeenUrl) {
      lastSeenUrl = location.href;
      onUrlChange();
    }
  }, 300);

  whenDocumentReady(function () {
    // First evaluation. If we're not on a files/changes page, this no-ops and
    // waits for a navigation event.
    onUrlChange();
    // Belt-and-braces: late retries cover the case where the diff list is
    // still rendering (React app hydrating) when the early checks ran.
    setTimeout(onUrlChange, 250);
    setTimeout(onUrlChange, 1000);
    setTimeout(onUrlChange, 3000);
  });

  // ── State machine ─────────────────────────────────────────────────────────

  function onUrlChange() {
    if (isFilesPage(location.href)) {
      ensureActive();
    } else {
      ensureInactive();
    }
  }

  function ensureActive() {
    api.active = true;
    injectStyles();
    syncActiveBodyFlag();
    applyVisibility();
    ensureToggleUI();
    ensureCollapseAllButton();
    syncViewedDecorations();
    startObserver();
  }

  function ensureInactive() {
    api.active = false;
    if (document.body) document.body.removeAttribute('data-ghpr-active');
    var t = document.getElementById(TOGGLE_ID);
    if (t) t.remove();
    var b = document.getElementById(COLLAPSE_BTN_ID);
    if (b) b.remove();
    // Clear any hide markers we'd previously set, so cached DOM looks
    // normal if Turbo brings it back.
    var hidden = document.querySelectorAll('[' + DATA_ATTR + '="1"]');
    for (var i = 0; i < hidden.length; i++) {
      hidden[i].setAttribute(DATA_ATTR, '0');
    }
    // Clear viewed decorations.
    var decorated = document.querySelectorAll('[' + VIEWED_ATTR + ']');
    for (var j = 0; j < decorated.length; j++) {
      decorated[j].removeAttribute(VIEWED_ATTR);
    }
    if (api.observer) {
      try { api.observer.disconnect(); } catch (_) {}
      api.observer = null;
    }
  }

  // ── Core logic ────────────────────────────────────────────────────────────

  function applyVisibility() {
    api.callCount = (api.callCount || 0) + 1;
    if (!api.active) return false;
    var wrappers = getFileWrappers();
    api.lastWrapperCount = wrappers.length;
    if (wrappers.length === 0) return false;

    if (api.disabled) {
      // Clear any markers we'd previously set so that a CSS rule keyed on
      // [data-ghpr-hidden="1"] no longer hides anything. Stop here.
      var changedAny = false;
      for (var k = 0; k < wrappers.length; k++) {
        if (wrappers[k].getAttribute(DATA_ATTR) === '1') {
          wrappers[k].setAttribute(DATA_ATTR, '0');
          changedAny = true;
        }
      }
      return changedAny;
    }

    var targetId = getCurrentTargetId();
    if (!targetId) {
      var firstInner = getInnerDiffId(wrappers[0]);
      if (!firstInner) return false;
      targetId = firstInner;
    }

    var changed = false;
    for (var i = 0; i < wrappers.length; i++) {
      var w = wrappers[i];
      var innerId = getInnerDiffId(w);
      var shouldHide = innerId !== targetId;
      var currentlyHidden = w.getAttribute(DATA_ATTR) === '1';
      if (shouldHide !== currentlyHidden) {
        w.setAttribute(DATA_ATTR, shouldHide ? '1' : '0');
        changed = true;
      }
    }
    api.lastTargetId = targetId;
    return changed;
  }

  function getFileWrappers() {
    if (!document.documentElement) return [];
    for (var i = 0; i < SELECTORS.fileWrappers.length; i++) {
      var nodes = document.querySelectorAll(SELECTORS.fileWrappers[i]);
      if (nodes.length > 0) return Array.prototype.slice.call(nodes);
    }
    return [];
  }

  function getInnerDiffId(wrapper) {
    if (wrapper.id && wrapper.id.indexOf('diff-') === 0) return wrapper.id;
    var inner = wrapper.querySelector(SELECTORS.innerDiffId);
    return inner ? inner.id : null;
  }

  function getCurrentTargetId() {
    var h = location.hash || '';
    if (h.indexOf('#diff-') !== 0) return null;
    var raw = h.slice(1);
    // GitHub appends e.g. "R12-R14" or similar to scroll to a specific line;
    // strip that to keep just the file id.
    var m = raw.match(/^(diff-[a-f0-9]+)/i);
    return m ? m[1] : raw;
  }

  function injectStyles() {
    if (!document.documentElement) return;
    if (document.getElementById(STYLE_ID)) return;
    // New + old UI hide rules. The selector list mirrors SELECTORS.fileWrappers
    // — keep them in sync.
    //
    // The :has() rule below is needed because in the new UI the parent of the
    // diff div ([id^="diff-"][data-targeted]) is a flex item under a parent
    // with `gap-3`. Hiding only the diff div leaves the wrapper as an empty
    // flex item that still claims gap, painting phantom whitespace around the
    // visible file. We therefore also collapse any direct child of the
    // progressive-diffs-list whose own child is hidden.
    var css =
      '[id^="diff-"][data-targeted][' + DATA_ATTR + '="1"],' +
      'copilot-diff-entry[' + DATA_ATTR + '="1"],' +
      '[data-targets="diff-file-filter.diffEntries"][' + DATA_ATTR + '="1"],' +
      'div.file.js-file[id^="diff-"][' + DATA_ATTR + '="1"]' +
      ' { display: none !important; }\n' +
      '[data-testid="progressive-diffs-list"] > *:has(> [' + DATA_ATTR + '="1"])' +
      ' { display: none !important; }\n' +
      // While our script is active, kill the flex `gap` on the new-UI diff
      // list. Otherwise the still-visible siblings of our chosen file (loading
      // animation, placeholder SVGs) get gap-spacing painted between them and
      // the file, producing phantom whitespace.
      'body[data-ghpr-active="1"] [data-testid="progressive-diffs-list"]' +
      ' { gap: 0 !important; }\n' +
      // ── Viewed-state decorations on the file tree ──
      // Files marked "Viewed" via GitHub's per-file checkbox get muted +
      // strikethrough; folders go full-opacity-but-checkmark when ALL of
      // their descendant files are viewed.
      '[role="treeitem"][' + VIEWED_ATTR + '="1"]' +
      ' { position: relative; }\n' +
      '[role="treeitem"][' + VIEWED_ATTR + '="1"]:not([aria-expanded]) > *' +
      ' { opacity: 0.55; text-decoration: line-through; }\n' +
      '[role="treeitem"][' + VIEWED_ATTR + '="1"]::after' +
      ' { content: "✓"; position: absolute; right: 8px; top: 50%;' +
      '   transform: translateY(-50%); color: var(--fgColor-success,#1a7f37);' +
      '   font: 700 13px/1 -apple-system,BlinkMacSystemFont,sans-serif;' +
      '   pointer-events: none; }\n' +
      '[role="treeitem"][' + VIEWED_ATTR + '="1"][aria-expanded] > *' +
      ' { color: var(--fgColor-success,#1a7f37); }';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    var parent = document.head || document.documentElement;
    if (!parent) return;
    parent.appendChild(style);
  }

  // ── Toggle UI + persistence ───────────────────────────────────────────────

  function readPersistedDisabled() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
  }

  function setDisabled(v) {
    api.disabled = !!v;
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (_) {}
    syncActiveBodyFlag();
    applyVisibility();
    syncToggleUI();
  }

  function syncActiveBodyFlag() {
    if (!document.body) return;
    document.body.setAttribute('data-ghpr-active', api.disabled ? '0' : '1');
  }

  function ensureToggleUI() {
    if (!document.body) return;
    if (document.getElementById(TOGGLE_ID)) {
      syncToggleUI();
      return;
    }
    var box = document.createElement('div');
    box.id = TOGGLE_ID;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Single-file mode toggle');
    box.style.cssText =
      'position:fixed;bottom:14px;right:14px;z-index:2147483647;' +
      'background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:6px;' +
      'padding:6px 10px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;' +
      'box-shadow:0 1px 3px rgba(31,35,40,0.12);user-select:none;';
    var label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.id = TOGGLE_INPUT_ID;
    input.style.margin = '0';
    input.checked = !api.disabled;
    input.addEventListener('change', function () { setDisabled(!input.checked); });
    var span = document.createElement('span');
    span.textContent = 'Single-file mode';
    label.appendChild(input);
    label.appendChild(span);
    box.appendChild(label);
    document.body.appendChild(box);
  }

  function syncToggleUI() {
    var input = document.getElementById(TOGGLE_INPUT_ID);
    if (input) input.checked = !api.disabled;
  }

  function startObserver() {
    if (!document.body) return;
    // GitHub re-renders the diff list aggressively when users tick "Mark as
    // viewed", post review comments, or scroll into newly-rendered hunks.
    // Turbo also nukes-and-replaces the body on tab navigations, leaving any
    // previous observer attached to a detached node — so we always disconnect
    // any prior observer before re-attaching to the current body.
    if (api.observer) {
      try { api.observer.disconnect(); } catch (_) {}
    }
    var queued = false;
    var observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      var schedule = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : function (cb) { return setTimeout(cb, 0); };
      schedule(function () {
        queued = false;
        if (!api.active) return;
        applyVisibility();
        ensureCollapseAllButton();
        ensureToggleUI();
        syncViewedDecorations();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    api.observer = observer;
  }

  // ── Collapse-all-folders button (file tree) ───────────────────────────────

  function ensureCollapseAllButton() {
    if (!document.body) return;
    if (document.getElementById(COLLAPSE_BTN_ID)) return;

    // Only relevant if we have a tree with collapsible folders.
    var tree = document.querySelector('[role="tree"][aria-label="File Tree"]');
    if (!tree) return;
    if (!document.querySelector('[role="treeitem"][aria-expanded]')) return; // no folders

    // Preferred anchor: the filter input's container — that puts the button
    // right next to GitHub's own filter input. Fall back to inserting just
    // before the tree itself.
    var filter = document.querySelector('[data-testid="diff-file-tree-filter"]');
    var anchor = filter || tree.parentElement;
    if (!anchor) return;

    var btn = document.createElement('button');
    btn.id = COLLAPSE_BTN_ID;
    btn.type = 'button';
    btn.title = 'Collapse all folders in the file tree';
    btn.textContent = 'Collapse all';
    btn.style.cssText =
      'display:inline-flex;align-items:center;gap:4px;' +
      'margin:6px 0 4px 0;padding:3px 8px;' +
      'font:11px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;' +
      'background:transparent;color:var(--fgColor-muted,#59636e);' +
      'border:1px solid var(--borderColor-default,#d0d7de);border-radius:5px;' +
      'cursor:pointer;user-select:none;';
    btn.addEventListener('click', collapseAllFolders);
    btn.addEventListener('mouseenter', function () { btn.style.background = 'var(--bgColor-muted,#f6f8fa)'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = 'transparent'; });

    if (filter) {
      // Sit on a row below the filter input.
      filter.appendChild(btn);
    } else if (tree.parentElement) {
      tree.parentElement.insertBefore(btn, tree);
    }
  }

  // ── Viewed-state decorations on the file tree ─────────────────────────────

  function syncViewedDecorations() {
    if (!document.body) return;

    // Step 1: build a {diffId → viewed} map from the diff entries on the page.
    // Each diff has a per-file "Viewed" / "Not Viewed" toggle; aria-label
    // reflects the *current* state.
    var viewedById = Object.create(null);
    var diffs = document.querySelectorAll('[id^="diff-"][data-targeted]');
    if (diffs.length === 0) {
      // Old UI fallback: copilot-diff-entry wraps an inner [id^="diff-"] div.
      diffs = document.querySelectorAll('copilot-diff-entry');
    }
    for (var i = 0; i < diffs.length; i++) {
      var d = diffs[i];
      var diffId;
      if (d.id && d.id.indexOf('diff-') === 0) {
        diffId = d.id;
      } else {
        var inner = d.querySelector('[id^="diff-"]');
        diffId = inner ? inner.id : null;
      }
      if (!diffId) continue;
      var hasViewed = !!d.querySelector('[aria-label="Viewed"]');
      var hasNotViewed = !!d.querySelector('[aria-label="Not Viewed"]');
      // If neither label is found (e.g. user not logged in), skip — we have
      // no signal.
      if (hasViewed && !hasNotViewed) viewedById[diffId] = true;
      else if (hasNotViewed && !hasViewed) viewedById[diffId] = false;
    }

    if (Object.keys(viewedById).length === 0) return;

    // Step 2: decorate file tree items.
    var allItems = document.querySelectorAll('[role="treeitem"]');
    var fileItems = [];
    for (var j = 0; j < allItems.length; j++) {
      var item = allItems[j];
      if (item.hasAttribute('aria-expanded')) continue; // it's a folder
      fileItems.push(item);
      var anchor = item.querySelector('a[href^="#diff-"]');
      if (!anchor) continue;
      var href = anchor.getAttribute('href') || '';
      var fileDiffId = href.slice(1).replace(/[?].*$/, '');
      var viewed = viewedById[fileDiffId];
      if (typeof viewed === 'boolean') {
        var want = viewed ? '1' : '0';
        if (item.getAttribute(VIEWED_ATTR) !== want) {
          item.setAttribute(VIEWED_ATTR, want);
        }
      }
    }

    // Step 3: roll up to folders. Tree-item ids are full repo-relative paths
    // (e.g. "src/components/Button.tsx"), folder ids are the directory prefix
    // (e.g. "src/components") — so a child file's id starts with `<folder-id>/`.
    for (var k = 0; k < allItems.length; k++) {
      var folder = allItems[k];
      if (!folder.hasAttribute('aria-expanded')) continue;
      if (!folder.id) continue;
      var prefix = folder.id + '/';
      var descendantsViewed = 0;
      var descendantsTotal = 0;
      for (var n = 0; n < fileItems.length; n++) {
        var f = fileItems[n];
        if (!f.id || f.id.indexOf(prefix) !== 0) continue;
        descendantsTotal++;
        if (f.getAttribute(VIEWED_ATTR) === '1') descendantsViewed++;
      }
      if (descendantsTotal === 0) {
        if (folder.hasAttribute(VIEWED_ATTR)) folder.removeAttribute(VIEWED_ATTR);
        continue;
      }
      var folderWant = descendantsViewed === descendantsTotal ? '1' : '0';
      if (folder.getAttribute(VIEWED_ATTR) !== folderWant) {
        folder.setAttribute(VIEWED_ATTR, folderWant);
      }
    }
  }

  function collapseAllFolders() {
    var folders = Array.prototype.slice.call(
      document.querySelectorAll('[role="treeitem"][aria-expanded="true"]'),
    );
    // Click deepest-first so a parent collapse doesn't visually swallow a
    // child whose state we still want to flip.
    folders.sort(function (a, b) {
      var la = parseInt(a.getAttribute('aria-level') || '0', 10);
      var lb = parseInt(b.getAttribute('aria-level') || '0', 10);
      return lb - la;
    });
    folders.forEach(function (el) {
      try { el.click(); } catch (_) {}
    });
  }

  function patchHistoryMethods() {
    if (api.historyPatched) return;
    api.historyPatched = true;
    try {
      var p = history.pushState;
      var r = history.replaceState;
      history.pushState = function () {
        var v = p.apply(this, arguments);
        try { onUrlChange(); } catch (_) {}
        return v;
      };
      history.replaceState = function () {
        var v = r.apply(this, arguments);
        try { onUrlChange(); } catch (_) {}
        return v;
      };
    } catch (_) {
      // Some browsers / sandboxed contexts may not allow patching. We still
      // have hashchange + Turbo events + the polling fallback.
    }
  }

  function whenDocumentReady(fn) {
    if (document.documentElement) {
      if (document.readyState === 'loading') {
        // documentElement exists, parser is still going. Run now (safe) and
        // also schedule re-run at DOMContentLoaded so we pick up later DOM.
        fn();
        document.addEventListener('DOMContentLoaded', fn, { once: true });
        return;
      }
      fn();
      return;
    }
    // documentElement not yet built. Poll briefly until it appears, then run.
    var poll = setInterval(function () {
      if (document.documentElement) {
        clearInterval(poll);
        fn();
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', fn, { once: true });
        }
      }
    }, 10);
    setTimeout(function () { clearInterval(poll); }, 5000);
  }

  function isFilesPage(href) {
    // GitHub's new (Jan 2026) UI uses /changes; legacy/Tampermonkey-installed
    // links may still hit /files (which redirects). We support both.
    return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)(?:[/?#].*)?$/.test(href);
  }
})();
