/**
 * linkedin_terminal_emulator v4
 *
 * Two-level keyboard navigation inspired by Pine/Elm:
 *   Level 1 (Browse): ↑↓ navigate posts
 *   Level 2 (Action): → enters post, ←→ cycles actions, Enter activates
 *
 * Uses structural/positional DOM detection — no reliance on
 * LinkedIn's obfuscated class names.
 */

(function () {
  'use strict';

  const STATE_KEY = 'linkedin-reader-enabled';
  const BODY_CLASS = 'lr-text-mode';
  const STYLE_PATCH_ATTR = 'data-lr-style-patched';

  let isEnabled = false;
  let mutationObserver = null;
  let observerTimer = null;
  let observerNeedsLayoutRefresh = false;
  let lastObserverRefreshAt = 0;
  let selectedIndex = -1;       // Currently highlighted post index
  let shouldAutoSelectFirstPost = false;
  let endOfFeedSelected = false;
  let isLoadingMore = false;
  let postElements = [];        // Ordered list of detected post elements
  let postCount = 0;            // For status bar display
  let recoveryTimer = null;
  let recoveryAttempts = 0;
  const originalInlineStyles = new WeakMap();

  // ── Two-level navigation state ───────────────────────────────────────
  let actionMode = false;       // true = inside a post's action bar
  let actionButtons = [];       // Action buttons in the current post
  let actionIndex = -1;         // Which action button is focused
  const ACTION_NAMES = ['like', 'comment', 'repost', 'send'];

  // ── Topic View state ───────────────────────────────────────────────────
  let topicViewActive = false;       // Is the topic index overlay showing?
  let topicData = [];                // Array of { name, posts[] }
  let topicIndex = 0;                // Which topic row is selected
  let topicPostIndex = 0;            // Which post within the selected topic
  let postDataCache = [];            // Extracted data for each post element

  // ── Font size state ────────────────────────────────────────────────────
  const FONT_KEY = 'linkedin-reader-fontsize';
  const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22, 24];
  let fontSizeIndex = 4;             // Default: 16px (index 4)

  // ── Page type detection ──────────────────────────────────────────────
  let pageType = 'feed';             // 'feed', 'profile', 'other'
  let profileSections = [];          // Navigable sections on profile pages
  let profileSectionIndex = -1;

  function detectPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/in/')) return 'profile';
    if (path.startsWith('/feed') || path === '/') return 'feed';
    return 'other';
  }

  function applyLayoutDensity() {
    const root = document.documentElement;
    const viewportWidth = Math.max(root.clientWidth || 0, window.innerWidth || 0);

    let contentMaxWidth = 960;
    let contentPaddingX = 16;
    let postPaddingX = 24;

    if (pageType === 'other') {
      contentMaxWidth = viewportWidth >= 1700 ? 1280 : viewportWidth >= 1400 ? 1180 : 1040;
      contentPaddingX = viewportWidth >= 1400 ? 10 : 8;
      postPaddingX = viewportWidth >= 1400 ? 18 : 16;
    } else if (isSinglePostPage()) {
      contentMaxWidth = viewportWidth >= 1700 ? 1180 : viewportWidth >= 1400 ? 1080 : 980;
      contentPaddingX = 12;
      postPaddingX = 20;
    } else if (pageType === 'feed') {
      contentMaxWidth = viewportWidth >= 1700 ? 1040 : 980;
      contentPaddingX = 14;
      postPaddingX = 22;
    }

    root.style.setProperty('--lr-content-max-width', `${contentMaxWidth}px`);
    root.style.setProperty('--lr-content-padding-x', `${contentPaddingX}px`);
    root.style.setProperty('--lr-post-padding-x', `${postPaddingX}px`);
  }

  function isSinglePostPage() {
    const path = window.location.pathname;
    return path.startsWith('/feed/update/') || path.startsWith('/posts/');
  }

  function shouldUseLoadMoreRow() {
    return pageType === 'feed' && !isSinglePostPage();
  }

  // ── State ────────────────────────────────────────────────────────────────
  function getState(cb) {
    chrome.storage.local.get([STATE_KEY, FONT_KEY], r => {
      fontSizeIndex = typeof r[FONT_KEY] === 'number' ? r[FONT_KEY] : 4;
      cb(r[STATE_KEY] === true);
    });
  }
  function setState(v) {
    chrome.storage.local.set({ [STATE_KEY]: v });
  }
  function saveFontSize() {
    chrome.storage.local.set({ [FONT_KEY]: fontSizeIndex });
  }

  function rememberInlineStyle(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (!originalInlineStyles.has(el)) {
      originalInlineStyles.set(el, el.getAttribute('style'));
      el.setAttribute(STYLE_PATCH_ATTR, 'true');
    }
  }

  function applyInlineStyle(el, cssText) {
    rememberInlineStyle(el);
    el.style.cssText = cssText;
  }

  function mutateInlineStyle(el, mutate) {
    rememberInlineStyle(el);
    mutate(el.style);
  }

  function restoreInlineStyle(el, options = {}) {
    if (!el || !originalInlineStyles.has(el)) {
      el?.removeAttribute(STYLE_PATCH_ATTR);
      return;
    }

    const original = originalInlineStyles.get(el);
    if (original === null) el.removeAttribute('style');
    else el.setAttribute('style', original);

    if (!options.preserveSnapshot) {
      originalInlineStyles.delete(el);
      el.removeAttribute(STYLE_PATCH_ATTR);
    }
  }

  function isReaderOwnedElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node;
    const className = typeof el.className === 'string' ? el.className : '';
    return (typeof el.id === 'string' && el.id.startsWith('lr-')) ||
      /\blr-/.test(className) ||
      !!el.closest?.('#lr-terminal-header, #lr-status-bar, #lr-topic-overlay');
  }

  function applyFontSize() {
    const size = FONT_SIZES[fontSizeIndex];
    const root = document.documentElement;
    root.style.setProperty('--lr-font-size', size + 'px');
    root.style.setProperty('--lr-font-size-sm', Math.max(11, size - 3) + 'px');
    root.style.setProperty('--lr-font-size-lg', (size + 2) + 'px');
    root.style.setProperty('--lr-font-size-xl', (size + 4) + 'px');
    root.style.setProperty('--lr-line-height', size <= 14 ? '1.55' : size <= 18 ? '1.65' : '1.75');
    // Update the font size display in the menu bar
    const sizeEl = document.getElementById('lr-font-size');
    if (sizeEl) sizeEl.textContent = size + 'px';
  }

  function changeFontSize(delta) {
    const newIndex = fontSizeIndex + delta;
    if (newIndex < 0 || newIndex >= FONT_SIZES.length) return;
    fontSizeIndex = newIndex;
    applyFontSize();
    saveFontSize();
    flashAction(FONT_SIZES[fontSizeIndex] + 'px');
  }

  function ensureTextModeClasses() {
    if (!isEnabled || !document.body) return;
    document.documentElement.classList.add(BODY_CLASS);
    document.body.classList.add(BODY_CLASS);
    if (pageType === 'profile') document.body.classList.add('lr-profile-page');
    else document.body.classList.remove('lr-profile-page');
    applyLayoutDensity();
  }

  function clearRecoveryTimer() {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  }

  function scheduleRecoveryPass() {
    const recoveryDelays = [350, 700, 1200, 1800, 2600, 3600, 4800, 6200];
    if (!isEnabled || pageType === 'profile' || recoveryTimer || recoveryAttempts >= recoveryDelays.length) return;
    recoveryAttempts++;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!isEnabled) return;
      ensureTextModeClasses();
      restructurePage({ fullLayout: true });
      collectPosts();
      maybeAutoSelectFirstPost();
      if (
        postElements.length === 0 ||
        !document.documentElement.classList.contains(BODY_CLASS) ||
        !document.body?.classList.contains(BODY_CLASS)
      ) {
        scheduleRecoveryPass();
      }
    }, recoveryDelays[recoveryAttempts - 1]);
  }

  // ── Toggle ───────────────────────────────────────────────────────────────
  function enable() {
    isEnabled = true;
    shouldAutoSelectFirstPost = true;
    clearRecoveryTimer();
    recoveryAttempts = 0;
    pageType = detectPageType();
    ensureTextModeClasses();
    applyFontSize();
    injectMenuBar();
    injectStatusBar();

    if (pageType === 'profile') {
      restructureProfilePage();
    } else {
      restructurePage();
      collectPosts();
      maybeAutoSelectFirstPost();
    }
    startObserver();
    document.addEventListener('keydown', handleKeyboard);
    document.addEventListener('click', handlePointerSelection, true);
  }

  function disable() {
    isEnabled = false;
    selectedIndex = -1;
    shouldAutoSelectFirstPost = false;
    endOfFeedSelected = false;
    isLoadingMore = false;
    clearRecoveryTimer();
    recoveryAttempts = 0;
    postElements = [];
    profileSections = [];
    profileSectionIndex = -1;
    exitActionMode();
    closeTopicView();
    document.documentElement.classList.remove(BODY_CLASS);
    document.body.classList.remove(BODY_CLASS);
    document.body.classList.remove('lr-profile-page');
    stopObserver();
    document.removeEventListener('keydown', handleKeyboard);
    document.removeEventListener('click', handlePointerSelection, true);
    removeMenuBar();
    removeStatusBar();
    restoreCollapsedMediaContainers();
    document.querySelectorAll(`[${STYLE_PATCH_ATTR}="true"]`).forEach(el => {
      restoreInlineStyle(el);
    });
    // Restore all modified elements
    document.querySelectorAll('[data-lr-hidden]').forEach(el => {
      el.removeAttribute('data-lr-hidden');
    });
    document.querySelectorAll('[data-lr-expanded]').forEach(el => {
      el.removeAttribute('data-lr-expanded');
    });
    document.querySelectorAll('[data-lr-collapsed]').forEach(el => {
      el.removeAttribute('data-lr-collapsed');
    });
    document.querySelectorAll('[data-lr-original-style], [data-lr-original-height], [data-lr-original-html]').forEach(el => {
      el.removeAttribute('data-lr-original-style');
      el.removeAttribute('data-lr-original-height');
      el.removeAttribute('data-lr-original-html');
    });
    document.querySelectorAll('[data-lr-media-holder]').forEach(el => {
      el.removeAttribute('data-lr-media-holder');
    });
    document.querySelectorAll('[data-lr-headshot]').forEach(el => {
      el.removeAttribute('data-lr-headshot');
    });
    document.querySelectorAll('[data-lr-post]').forEach(el => {
      el.removeAttribute('data-lr-post');
      el.removeAttribute('data-lr-selected');
    });
    document.querySelectorAll('[data-lr-section]').forEach(el => {
      el.removeAttribute('data-lr-section');
      el.removeAttribute('data-lr-section-name');
      el.removeAttribute('data-lr-section-selected');
    });
    document.querySelectorAll('[data-lr-profile-photo]').forEach(el => {
      el.removeAttribute('data-lr-profile-photo');
    });
    document.querySelectorAll('[data-lr-profile-banner]').forEach(el => {
      el.removeAttribute('data-lr-profile-banner');
    });
    document.querySelectorAll('[data-lr-profile-main]').forEach(el => {
      el.removeAttribute('data-lr-profile-main');
    });
    document.querySelectorAll('[data-lr-profile-rail]').forEach(el => {
      el.removeAttribute('data-lr-profile-rail');
    });
    document.querySelectorAll('[data-lr-profile-container]').forEach(el => {
      el.removeAttribute('data-lr-profile-container');
    });
    document.querySelectorAll('[data-lr-media-done]').forEach(el => {
      el.removeAttribute('data-lr-media-done');
    });
    document.querySelectorAll('.lr-post-index').forEach(el => el.remove());
    document.getElementById('lr-load-more-row')?.remove();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MENU BAR & STATUS BAR
  // ══════════════════════════════════════════════════════════════════════════

  function injectMenuBar() {
    if (document.getElementById('lr-terminal-header')) return;
    const bar = document.createElement('div');
    bar.id = 'lr-terminal-header';
    document.body.prepend(bar);
    updateMenuBar();
  }

  function updateMenuBar() {
    const bar = document.getElementById('lr-terminal-header');
    if (!bar) return;
    const size = FONT_SIZES[fontSizeIndex];
    const pageLabel = pageType === 'profile' ? 'PROFILE' : pageType === 'other' ? 'PAGE' : 'FEED';
    bar.innerHTML = `
      <span class="lr-prompt">linkedin_terminal_emulator</span>
      <span class="lr-cmd">${pageLabel}</span>
      <span class="lr-url">${window.location.pathname}</span>
      <span class="lr-font-controls" id="lr-font-controls">
        <span class="lr-font-btn" id="lr-font-down">−</span>
        <span class="lr-font-size" id="lr-font-size">${size}px</span>
        <span class="lr-font-btn" id="lr-font-up">+</span>
      </span>
      <span class="lr-post-counter" id="lr-post-counter">Post 0 of 0</span>
      <span class="lr-status">Pine/Elm Mode</span>
      <span class="lr-help">? Help</span>
    `;
    // Click handlers for the font buttons
    bar.querySelector('#lr-font-down')?.addEventListener('click', (e) => {
      e.stopPropagation();
      changeFontSize(-1);
    });
    bar.querySelector('#lr-font-up')?.addEventListener('click', (e) => {
      e.stopPropagation();
      changeFontSize(1);
    });
  }

  function removeMenuBar() {
    document.getElementById('lr-terminal-header')?.remove();
  }

  function injectStatusBar() {
    if (document.getElementById('lr-status-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'lr-status-bar';
    document.body.appendChild(bar);
    updateStatusBar();
  }

  function updateStatusBar() {
    const bar = document.getElementById('lr-status-bar');
    if (!bar) return;
    if (topicViewActive) {
      bar.innerHTML = `
        <span class="lr-mode-tag lr-mode-topic">TOPICS</span>
        <span class="lr-key">↑</span><span class="lr-key">↓</span><span class="lr-label">Topic</span>
        <span class="lr-key">←</span><span class="lr-key">→</span><span class="lr-label">Scroll posts</span>
        <span class="lr-key">Enter</span><span class="lr-label">Jump to post</span>
        <span class="lr-divider">│</span>
        <span class="lr-key">Esc</span><span class="lr-label">Back to feed</span>
        <span class="lr-key">S</span><span class="lr-label">Scan more</span>
      `;
    } else if (actionMode) {
      bar.innerHTML = `
        <span class="lr-mode-tag">ACTION</span>
        <span class="lr-key">←</span><span class="lr-key">→</span><span class="lr-label">Cycle</span>
        <span class="lr-key">Enter</span><span class="lr-label">Activate</span>
        <span class="lr-divider">│</span>
        <span class="lr-key">Esc</span><span class="lr-label">Back to feed</span>
        <span class="lr-divider">│</span>
        <span class="lr-key">O</span><span class="lr-label">Open author</span>
        <span class="lr-key">X</span><span class="lr-label">Expand media</span>
      `;
    } else if (pageType === 'profile') {
      bar.innerHTML = `
        <span class="lr-mode-tag lr-mode-browse">PROFILE</span>
        <span class="lr-key">↑</span><span class="lr-key">↓</span><span class="lr-label">Sections</span>
        <span class="lr-key">Enter</span><span class="lr-label">Open section</span>
        <span class="lr-divider">│</span>
        <span class="lr-key">G</span><span class="lr-label">Top</span>
        <span class="lr-key">M</span><span class="lr-label">Message</span>
        <span class="lr-key">C</span><span class="lr-label">Connect</span>
      `;
    } else {
      bar.innerHTML = `
        <span class="lr-mode-tag lr-mode-browse">BROWSE</span>
        <span class="lr-key">↑</span><span class="lr-key">↓</span><span class="lr-label">Navigate</span>
        <span class="lr-key">→</span><span class="lr-label">Open post</span>
        <span class="lr-divider">│</span>
        <span class="lr-key">L</span><span class="lr-label">Like</span>
        <span class="lr-key">C</span><span class="lr-label">Comment</span>
        <span class="lr-key">R</span><span class="lr-label">Repost</span>
        <span class="lr-divider">│</span>
        <span class="lr-key">X</span><span class="lr-label">Media</span>
        <span class="lr-key">T</span><span class="lr-label">Topics</span>
        <span class="lr-key">G</span><span class="lr-label">Top</span>
        <span class="lr-key">Esc</span><span class="lr-label">Deselect</span>
      `;
    }
  }

  function removeStatusBar() {
    document.getElementById('lr-status-bar')?.remove();
  }

  function updatePostCounter() {
    const counter = document.getElementById('lr-post-counter');
    if (!counter) return;
    if (pageType === 'profile') {
      if (profileSectionIndex >= 0 && profileSections.length > 0) {
        const name = profileSections[profileSectionIndex]?.getAttribute('data-lr-section-name') || 'Section';
        counter.textContent = `${name} (${profileSectionIndex + 1}/${profileSections.length})`;
      } else {
        counter.textContent = `${profileSections.length} sections`;
      }
    } else if (endOfFeedSelected) {
      counter.textContent = isLoadingMore
        ? `Loading more (${postElements.length} posts)`
        : `End of feed ▸ View more (${postElements.length} posts)`;
    } else if (actionMode && actionIndex >= 0 && actionIndex < actionButtons.length) {
      const btnName = actionButtons[actionIndex].innerText.trim();
      counter.textContent = `Post ${selectedIndex + 1} of ${postElements.length} ▸ ${btnName}`;
    } else {
      counter.textContent = `Post ${selectedIndex + 1} of ${postElements.length}`;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KEYBOARD NAVIGATION — Two-level model
  // Level 1 (Browse): ↑↓/JK navigate posts, → enters action mode
  // Level 2 (Action): ←→ cycle actions, Enter activates, Esc exits
  // ══════════════════════════════════════════════════════════════════════════

  function handleKeyboard(e) {
    if (!isEnabled) return;

    // Don't intercept when user is typing in an input/textarea
    const tag = e.target.tagName;
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' ||
      e.target.isContentEditable || e.target.getAttribute('role') === 'textbox';
    if (isEditable) {
      // But let Esc exit the input and return to browse mode
      if (e.key === 'Escape') {
        e.target.blur();
        e.preventDefault();
      }
      return;
    }

    // Alt+Shift+L — toggle off
    if (e.altKey && e.shiftKey && e.key === 'L') {
      disable();
      setState(false);
      return;
    }

    // Font size controls — work in all modes
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      changeFontSize(1);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      changeFontSize(-1);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      fontSizeIndex = 4; // Reset to default 16px
      applyFontSize();
      saveFontSize();
      flashAction('RESET 16px');
      return;
    }

    // ── Dispatch based on current mode ─────────────────────────────────
    if (topicViewActive) {
      handleTopicViewKey(e);
    } else if (pageType === 'profile') {
      handleProfileKey(e);
    } else if (actionMode) {
      handleActionModeKey(e);
    } else {
      handleBrowseModeKey(e);
    }
  }

  // ── BROWSE MODE ─────────────────────────────────────────────────────────
  function handleBrowseModeKey(e) {
    const key = e.key;
    switch (key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        if (postElements.length === 0) { collectPosts(); }
        if (endOfFeedSelected) {
          activateLoadMore();
        } else if (selectedIndex < postElements.length - 1) {
          selectPost(selectedIndex + 1);
        } else if (shouldUseLoadMoreRow() && postElements.length > 0) {
          selectLoadMoreRow();
        } else {
          window.scrollBy(0, 300);
          setTimeout(() => {
            collectPosts();
            if (selectedIndex < postElements.length - 1) {
              selectPost(selectedIndex + 1);
            }
          }, 500);
        }
        break;

      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        if (endOfFeedSelected) {
          clearLoadMoreSelection();
          if (postElements.length > 0) selectPost(postElements.length - 1);
        } else if (selectedIndex > 0) {
          selectPost(selectedIndex - 1);
        }
        break;

      case 'ArrowRight':
      case 'Enter':
        e.preventDefault();
        if (endOfFeedSelected) activateLoadMore();
        else enterActionMode();
        break;

      case 'ArrowLeft':
      case 'Escape':
        e.preventDefault();
        deselectAll();
        break;

      case 'l':
        e.preventDefault();
        clickPostButton('like');
        break;

      case 'c':
        e.preventDefault();
        clickPostButton('comment');
        break;

      case 'r':
        e.preventDefault();
        clickPostButton('repost');
        break;

      case 's':
        e.preventDefault();
        clickPostButton('send');
        break;

      case 'x':
        e.preventDefault();
        toggleMediaInPost();
        break;

      case 't':
        e.preventDefault();
        openTopicView();
        break;

      case 'g':
        e.preventDefault();
        clearLoadMoreSelection();
        if (postElements.length > 0) selectPost(0);
        break;
    }
  }

  // ── ACTION MODE ─────────────────────────────────────────────────────────
  function handleActionModeKey(e) {
    const key = e.key;
    switch (key) {
      case 'ArrowRight':
      case 'Tab':
        e.preventDefault();
        if (actionButtons.length > 0) {
          actionIndex = (actionIndex + 1) % actionButtons.length;
          highlightActionButton();
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        if (actionIndex <= 0) {
          // At the start — exit action mode
          exitActionMode();
        } else {
          actionIndex--;
          highlightActionButton();
        }
        break;

      case 'ArrowDown':
      case 'j':
        // Exit action mode and go to next post
        e.preventDefault();
        exitActionMode();
        if (selectedIndex < postElements.length - 1) {
          selectPost(selectedIndex + 1);
        } else if (shouldUseLoadMoreRow() && postElements.length > 0) {
          selectLoadMoreRow();
        }
        break;

      case 'ArrowUp':
      case 'k':
        // Exit action mode and go to previous post
        e.preventDefault();
        exitActionMode();
        if (selectedIndex > 0) {
          selectPost(selectedIndex - 1);
        }
        break;

      case 'Enter':
        e.preventDefault();
        activateActionButton();
        break;

      case 'Escape':
        e.preventDefault();
        exitActionMode();
        break;

      case 'o':
        // Open author profile (only in action mode)
        e.preventDefault();
        openAuthorProfile();
        break;

      case 'x':
        // Expand/collapse media in current post
        e.preventDefault();
        toggleMediaInPost();
        break;

      // Quick-fire shortcuts still work in action mode
      case 'l':
        e.preventDefault();
        clickPostButton('like');
        break;
      case 'c':
        e.preventDefault();
        clickPostButton('comment');
        break;
      case 'r':
        e.preventDefault();
        clickPostButton('repost');
        break;
    }
  }

  // ── Enter/exit action mode ──────────────────────────────────────────────

  function enterActionMode() {
    if (selectedIndex < 0 || selectedIndex >= postElements.length) return;
    const post = postElements[selectedIndex];

    // Auto-expand "see more" when entering a post
    expandSelectedPost();

    // Find the action buttons (Like, Comment, Repost, Send)
    const allBtns = [...post.querySelectorAll('button')];
    actionButtons = allBtns.filter(btn => {
      const text = btn.innerText.trim().toLowerCase();
      return ACTION_NAMES.some(name => text === name);
    });

    if (actionButtons.length === 0) return; // No action buttons found

    actionMode = true;
    actionIndex = 0;
    post.setAttribute('data-lr-action-mode', 'true');
    highlightActionButton();
    updateStatusBar();
    updatePostCounter();
  }

  function exitActionMode() {
    if (!actionMode) return;
    // Clear action highlights
    actionButtons.forEach(btn => {
      btn.removeAttribute('data-lr-action-focused');
    });
    document.querySelectorAll('[data-lr-action-mode]').forEach(el => {
      el.removeAttribute('data-lr-action-mode');
    });
    actionMode = false;
    actionButtons = [];
    actionIndex = -1;
    updateStatusBar();
    updatePostCounter();
  }

  function highlightActionButton() {
    // Clear all action highlights
    actionButtons.forEach(btn => {
      btn.removeAttribute('data-lr-action-focused');
    });
    // Set the focused one
    if (actionIndex >= 0 && actionIndex < actionButtons.length) {
      actionButtons[actionIndex].setAttribute('data-lr-action-focused', 'true');
      // Scroll button into view if needed
      actionButtons[actionIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function activateActionButton() {
    if (actionIndex < 0 || actionIndex >= actionButtons.length) return;
    const btn = actionButtons[actionIndex];
    const text = btn.innerText.trim().toUpperCase();
    btn.click();
    flashAction(text);
  }

  function openAuthorProfile() {
    if (selectedIndex < 0 || selectedIndex >= postElements.length) return;
    const post = postElements[selectedIndex];
    const links = [...post.querySelectorAll('a[href]')];
    for (const link of links) {
      if (link.href.includes('/in/')) {
        window.open(link.href, '_blank');
        return;
      }
    }
  }

  function toggleMediaInPost() {
    if (selectedIndex < 0 || selectedIndex >= postElements.length) return;
    const post = postElements[selectedIndex];
    const expandedText = expandTruncatedTextInPost(post);
    // Find expand buttons or collapse buttons
    const expandBtn = post.querySelector('.lr-expand-media');
    const collapseBtn = post.querySelector('.lr-collapse-media');
    if (expandBtn) {
      expandBtn.click();
      flashAction(expandedText ? 'OPENED' : 'EXPANDED');
    } else if (expandedText) {
      flashAction('MORE');
    } else if (collapseBtn) {
      collapseBtn.click();
      flashAction('COLLAPSED');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TOPIC VIEW — Pine-style folder index grouped by hashtag
  // ══════════════════════════════════════════════════════════════════════════

  function extractPostData() {
    // Scan all tagged posts and extract structured data
    postDataCache = [];
    const tagged = document.querySelectorAll('[data-lr-post="true"]');

    tagged.forEach((el, i) => {
      const text = el.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // Extract hashtags
      const hashtagRegex = /#(\w[\w\d_]+)/g;
      const hashtags = [];
      let match;
      while ((match = hashtagRegex.exec(text)) !== null) {
        hashtags.push('#' + match[1].toLowerCase());
      }

      // Detect category signals
      const isPromoted = text.includes('Promoted') || text.includes('promoted');
      const isSuggested = text.includes('Suggested');
      const hasCommented = /\w+ commented/i.test(text);
      const hasLiked = /\w+ likes? this/i.test(text);
      const hasReposted = /\w+ reposted/i.test(text);

      // Extract author name (first link that goes to /in/)
      let author = 'Unknown';
      const authorLink = el.querySelector('a[href*="/in/"]');
      if (authorLink) {
        author = authorLink.innerText.trim().split('\n')[0];
      }

      // Extract a snippet (first substantial text line that isn't a name/title)
      let snippet = '';
      for (const line of lines) {
        if (line.length > 40 && !line.includes('Follow') &&
            !line.includes('comment') && !line.includes('repost') &&
            line !== author) {
          snippet = line.substring(0, 80);
          if (line.length > 80) snippet += '...';
          break;
        }
      }
      if (!snippet && lines.length > 2) {
        snippet = lines[2]?.substring(0, 80) || '';
      }

      // Determine interaction context
      let context = '';
      if (isPromoted) context = 'Promoted';
      else if (isSuggested) context = 'Suggested';
      else if (hasCommented) context = 'Commented';
      else if (hasLiked) context = 'Liked';
      else if (hasReposted) context = 'Reposted';

      postDataCache.push({
        el,
        author,
        snippet,
        hashtags,
        context,
        isPromoted,
        isSuggested,
        index: i
      });
    });

    return postDataCache;
  }

  function groupByTopic(posts) {
    // Count hashtag frequency
    const tagCount = {};
    posts.forEach(p => {
      p.hashtags.forEach(tag => {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      });
    });

    // Sort tags by frequency
    const sortedTags = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1]);

    // Assign each post to its most popular hashtag (or a fallback category)
    const groups = {};
    const assigned = new Set();

    // First pass: assign posts to top hashtags
    sortedTags.forEach(([tag]) => {
      const matching = posts.filter(p =>
        p.hashtags.includes(tag) && !assigned.has(p.index)
      );
      if (matching.length > 0) {
        groups[tag] = matching;
        matching.forEach(p => assigned.add(p.index));
      }
    });

    // Second pass: fallback categories for unassigned posts
    const promoted = posts.filter(p => p.isPromoted && !assigned.has(p.index));
    if (promoted.length > 0) {
      groups['Promoted'] = promoted;
      promoted.forEach(p => assigned.add(p.index));
    }

    const suggested = posts.filter(p => p.isSuggested && !assigned.has(p.index));
    if (suggested.length > 0) {
      groups['Suggested'] = suggested;
      suggested.forEach(p => assigned.add(p.index));
    }

    const commented = posts.filter(p => p.context === 'Commented' && !assigned.has(p.index));
    if (commented.length > 0) {
      groups['From comments'] = commented;
      commented.forEach(p => assigned.add(p.index));
    }

    // Everything else
    const uncategorized = posts.filter(p => !assigned.has(p.index));
    if (uncategorized.length > 0) {
      groups['Feed'] = uncategorized;
    }

    // Convert to sorted array
    topicData = Object.entries(groups).map(([name, posts]) => ({
      name,
      posts,
      count: posts.length
    }));

    // Sort: hashtags first (alphabetical), then special categories
    const specialOrder = ['Feed', 'Promoted', 'Suggested', 'From comments'];
    topicData.sort((a, b) => {
      const aSpecial = specialOrder.indexOf(a.name);
      const bSpecial = specialOrder.indexOf(b.name);
      if (aSpecial === -1 && bSpecial === -1) return b.count - a.count; // Both hashtags: by count
      if (aSpecial === -1) return -1; // Hashtags before special
      if (bSpecial === -1) return 1;
      return aSpecial - bSpecial;
    });

    return topicData;
  }

  function openTopicView() {
    // Collect and analyze posts
    collectPosts();
    const posts = extractPostData();
    if (posts.length === 0) {
      flashAction('NO POSTS');
      return;
    }
    groupByTopic(posts);

    topicViewActive = true;
    topicIndex = 0;
    topicPostIndex = 0;

    renderTopicView();
    updateStatusBar();
  }

  function closeTopicView() {
    topicViewActive = false;
    const overlay = document.getElementById('lr-topic-overlay');
    if (overlay) overlay.remove();
    updateStatusBar();
  }

  function renderTopicView() {
    let overlay = document.getElementById('lr-topic-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lr-topic-overlay';
      document.body.appendChild(overlay);
    }

    const totalPosts = postDataCache.length;
    const totalTopics = topicData.length;

    let html = `<div class="lr-topic-header">
      <span class="lr-topic-title">TOPIC INDEX</span>
      <span class="lr-topic-stats">${totalPosts} posts · ${totalTopics} topics</span>
      <span class="lr-topic-hint">T or Esc to close · S to scan more</span>
    </div>`;

    html += '<div class="lr-topic-list">';

    topicData.forEach((topic, ti) => {
      const isSelected = ti === topicIndex;
      const topicClass = isSelected ? 'lr-topic-row lr-topic-selected' : 'lr-topic-row';
      const nameClass = topic.name.startsWith('#') ? 'lr-topic-hashtag' : 'lr-topic-category';

      html += `<div class="${topicClass}" data-topic-index="${ti}">`;
      html += `<div class="lr-topic-row-header">`;
      html += `<span class="lr-topic-marker">${isSelected ? '▸' : ' '}</span>`;
      html += `<span class="${nameClass}">${escapeHtml(topic.name)}</span>`;
      html += `<span class="lr-topic-count">(${topic.count})</span>`;
      html += `</div>`;

      // Show post carousel for selected topic
      if (isSelected) {
        html += '<div class="lr-topic-carousel">';
        topic.posts.forEach((post, pi) => {
          const postClass = pi === topicPostIndex ?
            'lr-topic-post lr-topic-post-selected' : 'lr-topic-post';
          html += `<div class="${postClass}" data-post-idx="${post.index}">`;
          html += `<span class="lr-topic-post-num">[${pi + 1}]</span>`;
          html += `<span class="lr-topic-post-author">${escapeHtml(post.author)}</span>`;
          if (post.context) {
            html += `<span class="lr-topic-post-context">${escapeHtml(post.context)}</span>`;
          }
          html += `<div class="lr-topic-post-snippet">${escapeHtml(post.snippet)}</div>`;
          if (post.hashtags.length > 0) {
            html += `<div class="lr-topic-post-tags">${post.hashtags.map(t => escapeHtml(t)).join(' ')}</div>`;
          }
          html += `</div>`;
        });
        html += '</div>';
      }

      html += '</div>';
    });

    html += '</div>';
    overlay.innerHTML = html;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function handleTopicViewKey(e) {
    const key = e.key;
    switch (key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        if (topicIndex < topicData.length - 1) {
          topicIndex++;
          topicPostIndex = 0;
          renderTopicView();
        }
        break;

      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        if (topicIndex > 0) {
          topicIndex--;
          topicPostIndex = 0;
          renderTopicView();
        }
        break;

      case 'ArrowRight':
      case 'l':
        e.preventDefault();
        if (topicData[topicIndex] &&
            topicPostIndex < topicData[topicIndex].posts.length - 1) {
          topicPostIndex++;
          renderTopicView();
        }
        break;

      case 'ArrowLeft':
      case 'h':
        e.preventDefault();
        if (topicPostIndex > 0) {
          topicPostIndex--;
          renderTopicView();
        }
        break;

      case 'Enter':
        // Jump to the selected post in the feed
        e.preventDefault();
        jumpToTopicPost();
        break;

      case 'Escape':
      case 't':
        e.preventDefault();
        closeTopicView();
        break;

      case 's':
        // Scan: auto-scroll to load more posts
        e.preventDefault();
        scanMorePosts();
        break;
    }
  }

  function jumpToTopicPost() {
    if (!topicData[topicIndex]) return;
    const post = topicData[topicIndex].posts[topicPostIndex];
    if (!post) return;

    // Close topic view
    closeTopicView();

    // Find this post's element in the main post list and select it
    const targetEl = post.el;
    const idx = postElements.indexOf(targetEl);
    if (idx >= 0) {
      selectPost(idx);
    } else {
      // Scroll to it directly
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => window.scrollBy(0, -44), 200);
    }
  }

  function scanMorePosts() {
    flashAction('SCANNING...');
    closeTopicView();

    // Auto-scroll down to trigger infinite scroll and collect more posts
    let scrolls = 0;
    const maxScrolls = 8;
    const scrollInterval = setInterval(() => {
      window.scrollBy(0, window.innerHeight);
      scrolls++;
      restructurePage();
      collectPosts();
      if (scrolls >= maxScrolls) {
        clearInterval(scrollInterval);
        // Scroll back to top and open topic view with more posts
        window.scrollTo(0, 0);
        setTimeout(() => {
          collectPosts();
          openTopicView();
        }, 500);
      }
    }, 400);
  }

  // ── Post selection ───────────────────────────────────────────────────────

  function collectPosts() {
    const selectedPost = document.querySelector('[data-lr-post="true"][data-lr-selected="true"]');

    // Gather all elements tagged as posts, in DOM order (top to bottom)
    const all = document.querySelectorAll('[data-lr-post="true"]');
    // Sort by vertical position
    postElements = [...all].sort((a, b) => {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });
    postCount = postElements.length;
    if (postElements.length > 0) {
      recoveryAttempts = 0;
      clearRecoveryTimer();
    }

    // Add index badges
    postElements.forEach((post, i) => {
      let badge = post.querySelector('.lr-post-index');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'lr-post-index';
        post.prepend(badge);
      }
      badge.textContent = `[${i + 1}]`;
    });

    if (selectedPost) {
      const nextSelectedIndex = postElements.indexOf(selectedPost);
      if (nextSelectedIndex >= 0) {
        selectedIndex = nextSelectedIndex;
      }
    } else if (!endOfFeedSelected && selectedIndex >= 0 && postElements.length > 0) {
      selectedIndex = Math.min(selectedIndex, postElements.length - 1);
      postElements[selectedIndex].setAttribute('data-lr-selected', 'true');
    } else if (postElements.length === 0) {
      selectedIndex = -1;
    }

    syncLoadMoreRow();
    updatePostCounter();
    if (postElements.length === 0) scheduleRecoveryPass();
  }

  function getLoadMoreRow() {
    return document.getElementById('lr-load-more-row');
  }

  function syncLoadMoreRow() {
    const existing = getLoadMoreRow();
    if (!shouldUseLoadMoreRow() || postElements.length === 0) {
      existing?.remove();
      endOfFeedSelected = false;
      updatePostCounter();
      return;
    }

    let row = existing;
    if (!row) {
      row = document.createElement('div');
      row.id = 'lr-load-more-row';
      row.className = 'lr-load-more-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lr-load-more-button';
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateLoadMore();
      });
      row.appendChild(button);
    }

    row.querySelector('.lr-load-more-button').textContent = isLoadingMore
      ? '[ loading more... ]'
      : '[ view more ]';
    if (endOfFeedSelected) row.setAttribute('data-lr-load-more-selected', 'true');
    else row.removeAttribute('data-lr-load-more-selected');
    if (isLoadingMore) row.setAttribute('data-lr-load-more-loading', 'true');
    else row.removeAttribute('data-lr-load-more-loading');

    const lastPost = postElements[postElements.length - 1];
    if (lastPost && row.previousElementSibling !== lastPost) {
      lastPost.after(row);
    } else if (lastPost && !row.parentElement) {
      lastPost.after(row);
    }
  }

  function clearLoadMoreSelection() {
    endOfFeedSelected = false;
    const row = getLoadMoreRow();
    row?.removeAttribute('data-lr-load-more-selected');
    updatePostCounter();
  }

  function selectLoadMoreRow() {
    syncLoadMoreRow();
    const row = getLoadMoreRow();
    if (!row) return;

    deselectAll();
    endOfFeedSelected = true;
    row.setAttribute('data-lr-load-more-selected', 'true');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    updatePostCounter();
  }

  function activateLoadMore() {
    if (!shouldUseLoadMoreRow() || isLoadingMore) return;

    syncLoadMoreRow();
    const row = getLoadMoreRow();
    if (!row) return;

    isLoadingMore = true;
    endOfFeedSelected = true;
    row.setAttribute('data-lr-load-more-selected', 'true');
    row.setAttribute('data-lr-load-more-loading', 'true');
    const button = row.querySelector('.lr-load-more-button');
    if (button) button.textContent = '[ loading more... ]';
    updatePostCounter();
    flashAction('LOADING MORE');

    const previousCount = postElements.length;
    let attempts = 0;
    let previousScrollHeight = getDocumentScrollHeight();
    const maxAttempts = 6;

    const attemptLoad = () => {
      if (!isEnabled) return finishLoadMore(false);
      attempts++;
      row.scrollIntoView({ behavior: attempts === 1 ? 'smooth' : 'auto', block: 'end' });

      const nativeLoadMore = findNativeLoadMoreControl();
      nativeLoadMore?.click();

      const scrollTop = Math.max(getDocumentScrollHeight() - window.innerHeight + 80, 0);
      window.scrollTo({ top: scrollTop, behavior: attempts === 1 ? 'smooth' : 'auto' });
      window.scrollBy(0, Math.max(Math.floor(window.innerHeight * 0.9), 520));

      setTimeout(() => {
        restructurePage({ fullLayout: false });
        collectPosts();
        const currentScrollHeight = getDocumentScrollHeight();
        if (postElements.length > previousCount) {
          finishLoadMore(true, previousCount);
        } else if (currentScrollHeight > previousScrollHeight + 240 && attempts < maxAttempts) {
          previousScrollHeight = currentScrollHeight;
          attemptLoad();
        } else if (attempts >= maxAttempts) {
          finishLoadMore(false);
        } else {
          previousScrollHeight = currentScrollHeight;
          attemptLoad();
        }
      }, attempts === 1 ? 700 : 550);
    };

    const finishLoadMore = (loadedNewPosts, firstNewIndex = postElements.length) => {
      isLoadingMore = false;
      syncLoadMoreRow();
      if (loadedNewPosts) {
        selectPost(Math.min(firstNewIndex, postElements.length - 1));
      } else {
        flashAction('END OF FEED');
        selectLoadMoreRow();
      }
    };

    attemptLoad();
  }

  function maybeAutoSelectFirstPost() {
    if (!shouldAutoSelectFirstPost) return;
    if (selectedIndex >= 0) {
      shouldAutoSelectFirstPost = false;
      return;
    }
    if (postElements.length === 0) return;
    selectPost(0);
  }

  function isInteractiveSelectionTarget(target, post) {
    if (!(target instanceof Element) || !post) return false;
    const interactive = target.closest(
      'a[href], button, input, textarea, select, label, summary, [role="button"], [role="textbox"], [contenteditable="true"]'
    );
    return !!interactive && post.contains(interactive);
  }

  function handlePointerSelection(e) {
    if (!isEnabled || pageType === 'profile') return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const target = e.target;
    if (!(target instanceof Element) || isReaderOwnedElement(target)) return;

    const post = target.closest('[data-lr-post="true"]');
    if (!post) return;
    if (isInteractiveSelectionTarget(target, post)) return;

    if (!postElements.includes(post)) {
      collectPosts();
    }

    const index = postElements.indexOf(post);
    if (index < 0) return;
    if (selectedIndex === index && post.hasAttribute('data-lr-selected')) return;

    selectPost(index);
  }

  function selectPost(index) {
    if (index < 0 || index >= postElements.length) return;
    shouldAutoSelectFirstPost = false;

    // Exit action mode if active
    exitActionMode();

    // Remove previous selection
    deselectAll();
    clearLoadMoreSelection();

    selectedIndex = index;
    const post = postElements[index];
    post.setAttribute('data-lr-selected', 'true');

    // Scroll into view with some padding
    const rect = post.getBoundingClientRect();
    const headerH = 28;
    const statusH = 26;

    if (rect.top < headerH + 20 || rect.bottom > window.innerHeight - statusH - 20) {
      post.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Offset for the header bar
      setTimeout(() => {
        window.scrollBy(0, -(headerH + 16));
      }, 100);
    }

    updatePostCounter();
  }

  function deselectAll() {
    exitActionMode();
    shouldAutoSelectFirstPost = false;
    clearLoadMoreSelection();
    document.querySelectorAll('[data-lr-selected]').forEach(el => {
      el.removeAttribute('data-lr-selected');
    });
    selectedIndex = -1;
    updatePostCounter();
  }

  // ── Post actions ─────────────────────────────────────────────────────────

  function clickPostButton(action) {
    if (selectedIndex < 0 || selectedIndex >= postElements.length) return;
    const post = postElements[selectedIndex];

    // Find buttons in the post and match by text content
    const buttons = [...post.querySelectorAll('button')];
    const actionMap = {
      'like': /^like$/i,
      'comment': /^comment$/i,
      'repost': /^repost$/i,
      'send': /^send$/i,
    };

    const pattern = actionMap[action];
    if (!pattern) return;

    for (const btn of buttons) {
      const text = btn.innerText.trim().toLowerCase();
      if (pattern.test(text)) {
        btn.click();
        // Flash feedback
        flashAction(action.toUpperCase());
        return;
      }
    }

    // Fallback: try matching partial text
    for (const btn of buttons) {
      const text = btn.innerText.trim().toLowerCase();
      if (text.includes(action)) {
        btn.click();
        flashAction(action.toUpperCase());
        return;
      }
    }
  }

  function findExpandMoreControls(root) {
    return [...root.querySelectorAll('button, [role="button"], a')]
      .filter(control => {
        if (!control || isReaderOwnedElement(control)) return false;
        if (control.disabled) return false;
        const text = (control.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const ariaLabel = (control.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const label = `${text} ${ariaLabel}`.trim();
        if (!label) return false;
        if (/comments?|posts?|results?|view more|load more|show all/.test(label)) return false;
        return text === 'more' ||
          text === '…more' ||
          text === '...more' ||
          text === '… more' ||
          text === '... more' ||
          label.includes('see more');
      });
  }

  function expandTruncatedTextInPost(post) {
    if (!post) return false;
    const controls = findExpandMoreControls(post);
    if (controls.length === 0) return false;

    let expanded = false;
    controls.slice(0, 3).forEach(control => {
      control.click();
      expanded = true;
    });
    return expanded;
  }

  function expandSelectedPost() {
    if (selectedIndex < 0 || selectedIndex >= postElements.length) return false;
    const post = postElements[selectedIndex];
    return expandTruncatedTextInPost(post);
  }

  function flashAction(text) {
    // Brief visual flash in the status bar
    const counter = document.getElementById('lr-post-counter');
    if (!counter) return;
    const orig = counter.textContent;
    counter.textContent = `✓ ${text}`;
    counter.style.color = '#98c379';
    setTimeout(() => {
      counter.textContent = orig;
      counter.style.color = '';
    }, 800);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILE PAGE SUPPORT
  // ══════════════════════════════════════════════════════════════════════════

  function restructureProfilePage(options = {}) {
    if (!isEnabled) return;
    ensureTextModeClasses();
    const { fullLayout = true } = options;
    hideMessagingPanel();
    if (fullLayout || !document.querySelector('[data-lr-profile-main], [data-lr-profile-container]')) {
      tagProfileLayout();
    }
    tagProfileImages();
    tagProfileSections();
    updatePostCounter();
    // Layout is handled entirely by CSS — no DOM manipulation needed
    // The lr-profile-page class on body drives all layout changes
  }

  function tagProfileLayout() {
    const main = document.querySelector('main');
    if (!main) return;

    main.querySelectorAll('[data-lr-profile-main]').forEach(el => {
      el.removeAttribute('data-lr-profile-main');
    });
    main.querySelectorAll('[data-lr-profile-rail]').forEach(el => {
      el.removeAttribute('data-lr-profile-rail');
    });
    main.querySelectorAll('[data-lr-profile-container]').forEach(el => {
      el.removeAttribute('data-lr-profile-container');
    });

    const layout = findProfileLayout(main);
    if (!layout) return;

    layout.container.setAttribute('data-lr-profile-container', 'true');
    layout.mainColumn.setAttribute('data-lr-profile-main', 'true');
    layout.columns.forEach(({ el }) => {
      if (el !== layout.mainColumn) {
        el.setAttribute('data-lr-profile-rail', 'true');
      }
    });
  }

  function findProfileLayout(root) {
    let best = null;

    function visibleChildren(el) {
      return [...el.children]
        .map(child => ({
          el: child,
          rect: child.getBoundingClientRect(),
          style: window.getComputedStyle(child)
        }))
        .filter(({ rect, style }) => {
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (style.position === 'fixed') return false;
          return rect.width > 180 && rect.height > 120;
        });
    }

    function visit(el, depth) {
      if (depth > 7) return;

      const children = visibleChildren(el);
      if (children.length >= 2 && children.length <= 4) {
        const sortedByX = children.slice().sort((a, b) => a.rect.x - b.rect.x);
        const xSpread = sortedByX[sortedByX.length - 1].rect.x - sortedByX[0].rect.x;
        const ySpread = Math.max(...sortedByX.map(({ rect }) => rect.top)) -
          Math.min(...sortedByX.map(({ rect }) => rect.top));
        const sortedByWidth = children.slice().sort((a, b) => b.rect.width - a.rect.width);
        const widest = sortedByWidth[0];
        const next = sortedByWidth[1];

        if (xSpread > 180 && ySpread < 120 && widest && next &&
            widest.rect.width > next.rect.width * 1.15) {
          const score = widest.rect.width * widest.rect.height;
          if (!best || score > best.score) {
            best = {
              container: el,
              columns: sortedByX,
              mainColumn: widest.el,
              score
            };
          }
        }
      }

      [...el.children].forEach(child => visit(child, depth + 1));
    }

    visit(root, 0);
    return best;
  }

  function tagProfileImages() {
    // Show the main profile photo and background prominently
    const main = document.querySelector('main');
    if (!main) return;

    let mainPhotoFound = !!main.querySelector('[data-lr-profile-photo]');

    main.querySelectorAll('img:not([data-lr-media-done])').forEach(img => {
      img.setAttribute('data-lr-media-done', 'true');
      const src = img.src || img.getAttribute('src') || '';
      const alt = (img.alt || '').toLowerCase();
      const classes = img.className || '';
      const parentClasses = (img.parentElement?.className || '') +
                            (img.parentElement?.parentElement?.className || '');

      // Background/banner image
      const isBanner = src.includes('/profile-displaybackground') ||
                       src.includes('/headerBackground');

      if (isBanner) {
        img.setAttribute('data-lr-profile-banner', 'true');
        return;
      }

      // Profile photo detection signals
      const isProfileUrl = src.includes('/profile-displayphoto') ||
                           (src.includes('media.licdn.com/dms/image') &&
                            !src.includes('background') &&
                            (src.includes('/C4') || src.includes('/C5') || src.includes('/D4') || src.includes('/D5')));
      const classHints = /avatar|profile|headshot|presence|member/i.test(classes);
      const parentHints = /avatar|profile|headshot|presence|member|author/i.test(parentClasses);
      const altHints = /photo|profile|avatar/i.test(alt) || alt.endsWith("'s photo");

      // On profile pages, the main photo is typically the first profile-url image
      // Don't rely on width/height attrs as LinkedIn often lazy-loads without them
      if (!mainPhotoFound && isProfileUrl) {
        img.setAttribute('data-lr-profile-photo', 'true');
        mainPhotoFound = true;
      } else if (!mainPhotoFound && (classHints || parentHints || altHints)) {
        // First profile-looking image becomes the main photo
        img.setAttribute('data-lr-profile-photo', 'true');
        mainPhotoFound = true;
      } else if (isProfileUrl || classHints || parentHints || altHints) {
        // Subsequent profile-like images → headshots
        img.setAttribute('data-lr-headshot', 'true');
      }
    });
  }

  function tagProfileSections() {
    // LinkedIn profile pages have sections: About, Experience, Education, etc.
    // We detect them by looking for <section> elements or large content blocks
    // with heading text that matches known section names.
    const main = document.querySelector('main');
    if (!main) return;

    const sections = [];
    const sectionNames = /about|experience|education|skills|licenses|certifications|volunteer|publications|projects|courses|honors|awards|languages|recommendations|interests|activity|featured/i;

    // Strategy 1: Look for <section> elements with identifiable headings
    main.querySelectorAll('section').forEach(sec => {
      if (sec.getAttribute('data-lr-section')) return;
      const heading = sec.querySelector('h2, h3, [id*="profile"], [id*="section"]');
      const headingText = heading ? heading.innerText.trim() : '';
      const sectionId = sec.id || '';

      let name = '';
      if (sectionNames.test(headingText)) {
        name = headingText.split('\n')[0].trim();
      } else if (sectionNames.test(sectionId)) {
        name = sectionId.replace(/-/g, ' ');
      } else {
        // Check for any h2/h3 inside
        const anyH = sec.querySelector('h2');
        if (anyH) {
          name = anyH.innerText.trim().split('\n')[0].trim();
        }
      }

      if (name && name.length < 60) {
        sec.setAttribute('data-lr-section', 'true');
        sec.setAttribute('data-lr-section-name', name);
        sections.push(sec);
      }
    });

    // Strategy 2: If no sections found, look for large div blocks with headings
    if (sections.length === 0) {
      main.querySelectorAll('div').forEach(div => {
        if (div.getAttribute('data-lr-section')) return;
        const rect = div.getBoundingClientRect();
        if (rect.height < 100 || rect.width < 300) return;
        const h2 = div.querySelector(':scope > h2, :scope > div > h2');
        if (h2) {
          const text = h2.innerText.trim().split('\n')[0].trim();
          if (text && text.length < 60) {
            div.setAttribute('data-lr-section', 'true');
            div.setAttribute('data-lr-section-name', text);
            sections.push(div);
          }
        }
      });
    }

    // Update the navigable sections list
    profileSections = [...main.querySelectorAll('[data-lr-section="true"]')].sort((a, b) => {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });

    // Auto-select first section if none selected
    if (profileSections.length > 0 && profileSectionIndex < 0) {
      selectProfileSection(0);
    }
  }

  function selectProfileSection(index) {
    if (index < 0 || index >= profileSections.length) return;

    // Remove previous selection
    profileSections.forEach(sec => sec.removeAttribute('data-lr-section-selected'));

    profileSectionIndex = index;
    const sec = profileSections[index];
    sec.setAttribute('data-lr-section-selected', 'true');

    // Scroll into view
    const rect = sec.getBoundingClientRect();
    if (rect.top < 50 || rect.bottom > window.innerHeight - 40) {
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => window.scrollBy(0, -44), 100);
    }

    updatePostCounter();
  }

  function handleProfileKey(e) {
    const key = e.key;
    switch (key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        if (profileSections.length > 0) {
          selectProfileSection(Math.min(profileSectionIndex + 1, profileSections.length - 1));
        }
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        if (profileSections.length > 0) {
          selectProfileSection(Math.max(profileSectionIndex - 1, 0));
        }
        break;
      case 'g':
      case 'G':
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (profileSections.length > 0) selectProfileSection(0);
        break;
      case 'Enter':
        e.preventDefault();
        // Try to click "Show all" or expand button in current section
        if (profileSectionIndex >= 0 && profileSections[profileSectionIndex]) {
          const sec = profileSections[profileSectionIndex];
          const showAll = [...sec.querySelectorAll('a, button')].find(el => {
            const t = el.innerText.trim().toLowerCase();
            return t.includes('show all') || t.includes('see all') || t.includes('see more');
          });
          if (showAll) showAll.click();
        }
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        // Click Message button
        {
          const msgBtn = [...document.querySelectorAll('main button, main a')].find(el => {
            const t = el.innerText.trim().toLowerCase();
            return t === 'message';
          });
          if (msgBtn) { msgBtn.click(); flashAction('MESSAGE'); }
        }
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        // Click Connect button
        {
          const connectBtn = [...document.querySelectorAll('main button, main a')].find(el => {
            const t = el.innerText.trim().toLowerCase();
            return t === 'connect' || t === 'follow';
          });
          if (connectBtn) { connectBtn.click(); flashAction('CONNECT'); }
        }
        break;
      case 'Escape':
        e.preventDefault();
        profileSections.forEach(sec => sec.removeAttribute('data-lr-section-selected'));
        profileSectionIndex = -1;
        updatePostCounter();
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STRUCTURAL DOM RESTRUCTURING
  // ══════════════════════════════════════════════════════════════════════════

  function restructurePage(options = {}) {
    if (!isEnabled) return;
    // Guard: if the URL now points to a profile page, don't apply feed-mode
    // processing. This prevents damage during SPA navigation race conditions.
    if (detectPageType() === 'profile') return;
    ensureTextModeClasses();
    const { fullLayout = true } = options;
    if (fullLayout || !document.querySelector('[data-lr-expanded="feed"], [data-lr-expanded="main"]')) {
      hideSidebars();
      expandFeedColumn();
    }
    hideMessagingPanel();
    tagPosts();
    if (isSinglePostPage()) focusSinglePostLayout();
    else if (pageType === 'feed') focusFeedLayout();
    else if (pageType === 'other') focusPostCollectionLayout();
    processMedia();
  }

  // ── Find columns ─────────────────────────────────────────────────────────
  function findColumns() {
    const main = document.querySelector('main');
    if (!main) return null;

    function search(el, depth) {
      if (depth > 8) return null;
      if (el.children.length >= 2 && el.children.length <= 4) {
        const kids = [...el.children];
        const rects = kids.map(c => c.getBoundingClientRect());
        const visible = rects.filter(r => r.width > 50 && r.height > 50);
        if (visible.length >= 2) {
          const xs = visible.map(r => r.x);
          if (Math.max(...xs) - Math.min(...xs) > 200) return el;
        }
      }
      for (const child of el.children) {
        const found = search(child, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const container = search(main, 0);
    if (!container) return null;

    const withRects = [...container.children]
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(k => k.rect.width > 50)
      .sort((a, b) => a.rect.x - b.rect.x);

    if (withRects.length === 3) {
      return { left: withRects[0].el, feed: withRects[1].el, right: withRects[2].el, container };
    }
    if (withRects.length === 2) {
      const [a, b] = withRects;
      const wider = a.rect.width > b.rect.width ? a : b;
      const narrower = a.rect.width > b.rect.width ? b : a;
      return {
        left: narrower.rect.x < wider.rect.x ? narrower.el : null,
        feed: wider.el,
        right: narrower.rect.x > wider.rect.x ? narrower.el : null,
        container
      };
    }
    return null;
  }

  function hideSidebars() {
    const cols = findColumns();
    if (!cols) {
      // Fallback: hide any narrow siblings of the feed area inside main
      fallbackHideSidebars();
      return;
    }
    if (cols.left && !cols.left.getAttribute('data-lr-hidden')) {
      applyInlineStyle(cols.left, 'display: none !important;');
      cols.left.setAttribute('data-lr-hidden', 'sidebar-left');
    }
    if (cols.right && !cols.right.getAttribute('data-lr-hidden')) {
      applyInlineStyle(cols.right, 'display: none !important;');
      cols.right.setAttribute('data-lr-hidden', 'sidebar-right');
    }
  }

  function fallbackHideSidebars() {
    // When findColumns() fails, walk main's children and hide
    // anything that looks like a sidebar (narrow, tall)
    const main = document.querySelector('main');
    if (!main) return;

    // Look for the multi-column wrapper deeper in main
    function findSidebars(el, depth) {
      if (depth > 6) return;
      const kids = [...el.children].filter(c => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 50;
      });
      if (kids.length >= 2) {
        // Sort by width — the widest is likely the feed, hide the rest
        const sorted = kids.map(c => ({ el: c, w: c.getBoundingClientRect().width }))
                           .sort((a, b) => b.w - a.w);
        const feedWidth = sorted[0].w;
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].w < feedWidth * 0.6 && !sorted[i].el.getAttribute('data-lr-hidden')) {
            applyInlineStyle(sorted[i].el, 'display:none!important;');
            sorted[i].el.setAttribute('data-lr-hidden', 'sidebar-fallback');
          }
        }
        return;
      }
      kids.forEach(c => findSidebars(c, depth + 1));
    }
    findSidebars(main, 0);
  }

  function getActionLabels(el) {
    return [...el.querySelectorAll('button, [role="button"]')]
      .map(control => `${control.innerText || ''} ${control.getAttribute('aria-label') || ''}`.trim().toLowerCase())
      .filter(Boolean);
  }

  function hasRequiredPostActions(el) {
    const labels = getActionLabels(el);
    const hasLike = labels.some(text => text === 'like' || text === 'react' || text.includes('like'));
    const hasComment = labels.some(text => text === 'comment' || text.includes('comment'));
    const hasShare = labels.some(text =>
      text === 'share' ||
      text.includes('share') ||
      text.includes('repost') ||
      text.includes('send')
    );
    return { hasLike, hasComment, hasShare };
  }

  function isLikeActionControl(el) {
    const text = (el.innerText || '').trim().toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    return text === 'like' || text === 'react' || text === 'liked' ||
      ariaLabel.includes('like') || ariaLabel.includes('react');
  }

  function looksLikeNonPostComposer(text) {
    return text.includes('Start a post') ||
      text.includes('Write article') ||
      text.includes('Sort by');
  }

  function looksLikeMultiColumnContainer(el) {
    const visibleChildren = [...el.children]
      .map(child => ({ el: child, rect: child.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 120 && rect.height > 120);
    if (visibleChildren.length < 2) return false;
    const xs = visibleChildren.map(({ rect }) => rect.left);
    return Math.max(...xs) - Math.min(...xs) > 200;
  }

  function looksLikeSinglePostDetailCandidate(el, main) {
    if (!el || !main) return false;

    const rect = el.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const text = (el.innerText || '').trim();
    if (rect.width < Math.max(420, mainRect.width * 0.42)) return false;
    if (rect.height < 160 || rect.height > window.innerHeight * 5.5) return false;
    if (text.length < 80 || looksLikeNonPostComposer(text)) return false;
    if (looksLikeMultiColumnContainer(el)) return false;
    if (!el.querySelector('a[href*="/in/"]')) return false;

    const buttonTexts = getActionLabels(el);
    const hasLike = buttonTexts.some(label => label === 'like' || label === 'react' || label.includes('like'));
    const hasComment = buttonTexts.some(label => label === 'comment' || label.includes('comment'));
    const hasShare = buttonTexts.some(label => label.includes('share') || label.includes('repost') || label.includes('send'));
    const hasActionCluster = hasLike && (hasComment || hasShare);
    const hasComposer = !!el.querySelector('[role="textbox"], [contenteditable="true"]');
    const hasSocialCopy = /reactions?|most relevant|add a comment|add a reply|comment|repost|send|like/i.test(text);
    const looksLikeSidebar = /profile viewers|post impressions|retry premium|advertis|promoted/i.test(text);

    return !looksLikeSidebar && (hasActionCluster || (hasComposer && hasSocialCopy));
  }

  function scoreSinglePostDetailCandidate(el, main) {
    const rect = el.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const text = (el.innerText || '').trim();
    const buttonTexts = getActionLabels(el);
    const hasLike = buttonTexts.some(label => label === 'like' || label === 'react' || label.includes('like'));
    const hasComment = buttonTexts.some(label => label === 'comment' || label.includes('comment'));
    const hasShare = buttonTexts.some(label => label.includes('share') || label.includes('repost') || label.includes('send'));
    const hasActionCluster = hasLike && (hasComment || hasShare);
    const hasComposer = !!el.querySelector('[role="textbox"], [contenteditable="true"]');
    const authorLinks = el.querySelectorAll('a[href*="/in/"]').length;

    let score = 0;
    if (hasActionCluster) score += 5;
    if (hasComposer) score += 4;
    if (/most relevant|add a comment|add a reply|reactions?/i.test(text)) score += 3;
    if (authorLinks >= 1 && authorLinks <= 8) score += 2;
    score += Math.min(rect.width / Math.max(mainRect.width, 1), 1) * 2;
    score += Math.min(rect.height / Math.max(window.innerHeight, 1), 1.5);
    return score;
  }

  function promoteSinglePostContainer(primaryPost, main) {
    if (!primaryPost || !main) return primaryPost;

    let best = primaryPost;
    let bestRect = primaryPost.getBoundingClientRect();

    for (let ancestor = primaryPost.parentElement; ancestor && ancestor !== main; ancestor = ancestor.parentElement) {
      if (ancestor.getAttribute('data-lr-hidden') || isReaderOwnedElement(ancestor)) continue;

      const rect = ancestor.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 120) continue;
      if (rect.height > Math.max(window.innerHeight * 4.5, bestRect.height * 3.5)) break;
      if (looksLikeMultiColumnContainer(ancestor)) break;

      const innerText = ancestor.innerText || '';
      if (looksLikeNonPostComposer(innerText)) break;

      const { hasLike, hasComment } = hasRequiredPostActions(ancestor);
      if (!hasLike || !hasComment) continue;

      const expandsMeaningfully = rect.height > bestRect.height * 1.15 || rect.top < bestRect.top - 24;
      if (!expandsMeaningfully) continue;

      best = ancestor;
      bestRect = rect;
    }

    if (best !== primaryPost) {
      primaryPost.removeAttribute('data-lr-post');
      best.setAttribute('data-lr-post', 'true');
    }

    return best;
  }

  function hideSinglePostTopChrome(primaryPost) {
    if (!primaryPost) return;
    const main = document.querySelector('main');
    if (!main) return;

    const focusRect = primaryPost.getBoundingClientRect();
    let focusNode = primaryPost;

    while (focusNode && focusNode !== main) {
      const parent = focusNode.parentElement;
      if (!parent) break;

      [...parent.children].forEach(sibling => {
        if (sibling === focusNode || sibling.getAttribute('data-lr-hidden')) return;
        if (isReaderOwnedElement(sibling) || sibling.contains(primaryPost)) return;

        const rect = sibling.getBoundingClientRect();
        if (rect.width < 180 || rect.height < 50) return;

        const overlapsHorizontally = rect.left < focusRect.right - 60 && rect.right > focusRect.left + 60;
        const sitsAbove = rect.bottom <= focusRect.top + 20;
        if (!overlapsHorizontally || !sitsAbove) return;

        const text = (sibling.innerText || '').trim();
        if (!text) return;

        const profileLinkCount = sibling.querySelectorAll('a[href*="/in/"]').length;
        const { hasLike, hasComment } = hasRequiredPostActions(sibling);
        const hasPostActions = hasLike || hasComment;
        const looksLikeCompactChrome =
          rect.height < 220 &&
          !hasPostActions &&
          (/(recent|see all|sort by|most relevant)/i.test(text) || profileLinkCount >= 3 || text.length < 180);

        if (looksLikeCompactChrome) {
          applyInlineStyle(sibling, 'display:none!important;');
          sibling.setAttribute('data-lr-hidden', 'single-post-top-chrome');
        }
      });

      focusNode = parent;
    }
  }

  function expandFeedColumn() {
    const cols = findColumns();
    const main = document.querySelector('main');

    if (cols) {
      applyInlineStyle(cols.feed, 'max-width:var(--lr-content-max-width)!important;width:100%!important;margin:0 auto!important;flex:1!important;padding:0 var(--lr-content-padding-x)!important;');
      cols.feed.setAttribute('data-lr-expanded', 'feed');
      applyInlineStyle(cols.container, 'display:flex!important;justify-content:center!important;max-width:100%!important;width:100%!important;padding:0!important;margin:0!important;');
      cols.container.setAttribute('data-lr-expanded', 'container');
      let p = cols.container.parentElement;
      while (p && p !== document.body) {
        if (!p.getAttribute('data-lr-expanded')) {
          mutateInlineStyle(p, style => {
            style.maxWidth = '100%';
            style.width = '100%';
            style.padding = '0';
            style.margin = '0 auto';
          });
          p.setAttribute('data-lr-expanded', 'parent');
        }
        p = p.parentElement;
      }
    }

    // Fallback: force main and all its ancestors to be wide
    if (main && !main.getAttribute('data-lr-expanded')) {
      applyInlineStyle(main, 'max-width:100%!important;width:100%!important;padding:0!important;margin:0!important;');
      main.setAttribute('data-lr-expanded', 'main');
    }
    // Walk up from main and widen everything
    let ancestor = main?.parentElement;
    while (ancestor && ancestor !== document.body) {
      if (!ancestor.getAttribute('data-lr-expanded')) {
        mutateInlineStyle(ancestor, style => {
          style.maxWidth = '100%';
          style.width = '100%';
        });
        ancestor.setAttribute('data-lr-expanded', 'ancestor');
      }
      ancestor = ancestor.parentElement;
    }

    // Also find the widest child column inside main and expand it
    if (main) {
      const deepExpand = (el, depth) => {
        if (depth > 6 || el.getAttribute('data-lr-expanded')) return;
        const rect = el.getBoundingClientRect();
        // If this element is narrower than the viewport, widen it
        if (rect.width > 0 && rect.width < window.innerWidth * 0.8) {
          mutateInlineStyle(el, style => {
            style.maxWidth = 'var(--lr-content-max-width)';
            style.width = '100%';
            style.margin = '0 auto';
          });
          el.setAttribute('data-lr-expanded', 'deep');
        }
        [...el.children].forEach(c => deepExpand(c, depth + 1));
      };
      deepExpand(main, 0);
    }
  }

  function focusSinglePostLayout() {
    const main = document.querySelector('main');
    let primaryPost = document.querySelector('[data-lr-post="true"]');
    if (!main || !primaryPost) return;

    primaryPost = promoteSinglePostContainer(primaryPost, main);
    hideSinglePostTopChrome(primaryPost);

    let focusNode = primaryPost;
    while (focusNode && focusNode !== main) {
      const parent = focusNode.parentElement;
      if (!parent) break;

      const focusRect = focusNode.getBoundingClientRect();
      [...parent.children].forEach(sibling => {
        if (sibling === focusNode || sibling.getAttribute('data-lr-hidden')) return;
        if (isReaderOwnedElement(sibling)) return;

        const rect = sibling.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 120) return;

        const isLeftRail = rect.right <= focusRect.left - 40;
        const isRightRail = rect.left >= focusRect.right + 40;
        const isNarrowRail = rect.width < Math.max(360, focusRect.width * 0.6);

        if ((isLeftRail || isRightRail) && isNarrowRail) {
          applyInlineStyle(sibling, 'display:none!important;');
          sibling.setAttribute('data-lr-hidden', isLeftRail ? 'single-post-left-rail' : 'single-post-right-rail');
        }
      });

      if (!parent.getAttribute('data-lr-expanded')) {
        mutateInlineStyle(parent, style => {
          style.maxWidth = '100%';
          style.width = '100%';
          style.margin = '0 auto';
        });
        parent.setAttribute('data-lr-expanded', 'single-post-parent');
      }

      focusNode = parent;
    }
  }

  function focusPostCollectionLayout() {
    const main = document.querySelector('main');
    const primaryPost = document.querySelector('[data-lr-post="true"]');
    if (!main || !primaryPost) return;

    const focusRect = primaryPost.getBoundingClientRect();
    let focusNode = primaryPost;
    while (focusNode && focusNode !== main) {
      const parent = focusNode.parentElement;
      if (!parent) break;

      const currentRect = focusNode.getBoundingClientRect();
      [...parent.children].forEach(sibling => {
        if (sibling === focusNode || sibling.getAttribute('data-lr-hidden')) return;
        if (isReaderOwnedElement(sibling)) return;

        const rect = sibling.getBoundingClientRect();
        if (rect.width < 140 || rect.height < 80) return;

        const isLeftRail = rect.right <= currentRect.left - 40;
        const isRightRail = rect.left >= currentRect.right + 24;
        const isNarrowRail = rect.width < Math.max(420, currentRect.width * 0.55);

        if ((isLeftRail || isRightRail) && isNarrowRail) {
          applyInlineStyle(sibling, 'display:none!important;');
          sibling.setAttribute('data-lr-hidden', isLeftRail ? 'collection-left-rail' : 'collection-right-rail');
          return;
        }

        const overlapsHorizontally = rect.left < focusRect.right - 60 && rect.right > focusRect.left + 60;
        const sitsAbovePost = rect.bottom <= focusRect.top + 16;
        if (!overlapsHorizontally || !sitsAbovePost) return;

        const text = (sibling.innerText || '').trim();
        const profileLinkCount = sibling.querySelectorAll('a[href*="/in/"]').length;
        const looksLikeTopChrome =
          rect.height < 170 &&
          (/(recent|see all|sort by)/i.test(text) || profileLinkCount >= 4);

        if (looksLikeTopChrome) {
          applyInlineStyle(sibling, 'display:none!important;');
          sibling.setAttribute('data-lr-hidden', 'collection-top-chrome');
        }
      });

      if (!parent.getAttribute('data-lr-expanded')) {
        mutateInlineStyle(parent, style => {
          style.maxWidth = '100%';
          style.width = '100%';
          style.margin = '0 auto';
        });
        parent.setAttribute('data-lr-expanded', 'collection-parent');
      }

      focusNode = parent;
    }
  }

  function findFeedPostColumn(main, posts) {
    if (!main || posts.length === 0) return null;
    const targetPostCount = Math.min(posts.length, 3);
    const firstPost = posts[0];
    let best = firstPost;

    for (let ancestor = firstPost.parentElement; ancestor && ancestor !== main; ancestor = ancestor.parentElement) {
      if (ancestor.getAttribute('data-lr-hidden') || isReaderOwnedElement(ancestor)) continue;
      if (looksLikeMultiColumnContainer(ancestor)) break;

      const rect = ancestor.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 120) continue;

      const containedPosts = posts.filter(post => ancestor.contains(post)).length;
      if (containedPosts >= targetPostCount) {
        best = ancestor;
      }
    }

    return best;
  }

  function focusFeedLayout() {
    const main = document.querySelector('main');
    const posts = [...document.querySelectorAll('[data-lr-post="true"]')];
    if (!main || posts.length === 0) return;

    const column = findFeedPostColumn(main, posts);
    if (!column) return;

    if (!column.getAttribute('data-lr-expanded')) {
      mutateInlineStyle(column, style => {
        style.maxWidth = 'var(--lr-content-max-width)';
        style.width = '100%';
        style.margin = '0 auto';
      });
      column.setAttribute('data-lr-expanded', 'feed-column');
    }

    let focusNode = column;
    while (focusNode && focusNode !== main) {
      const parent = focusNode.parentElement;
      if (!parent) break;

      const currentRect = focusNode.getBoundingClientRect();
      [...parent.children].forEach(sibling => {
        if (sibling === focusNode || sibling.getAttribute('data-lr-hidden')) return;
        if (isReaderOwnedElement(sibling)) return;

        const rect = sibling.getBoundingClientRect();
        if (rect.width < 140 || rect.height < 80) return;

        const isLeftRail = rect.right <= currentRect.left - 40;
        const isRightRail = rect.left >= currentRect.right + 24;
        const isNarrowRail = rect.width < Math.max(360, currentRect.width * 0.55);

        if ((isLeftRail || isRightRail) && isNarrowRail) {
          applyInlineStyle(sibling, 'display:none!important;');
          sibling.setAttribute('data-lr-hidden', isLeftRail ? 'feed-left-rail' : 'feed-right-rail');
        }
      });

      if (!parent.getAttribute('data-lr-expanded')) {
        mutateInlineStyle(parent, style => {
          style.width = '100%';
          style.maxWidth = '100%';
          style.margin = '0 auto';
        });
        parent.setAttribute('data-lr-expanded', 'feed-parent');
      }

      focusNode = parent;
    }
  }

  function getDocumentScrollHeight() {
    return Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      document.documentElement?.offsetHeight || 0,
      document.body?.offsetHeight || 0
    );
  }

  function findNativeLoadMoreControl() {
    const controls = [...document.querySelectorAll('button, a, [role="button"]')];
    return controls.find(control => {
      if (!control || isReaderOwnedElement(control)) return false;
      if (control.closest?.('#lr-terminal-header, #lr-status-bar')) return false;
      const text = `${control.innerText || ''} ${control.getAttribute('aria-label') || ''}`.trim().toLowerCase();
      return /show more|load more|view more|more posts|see more posts|show more results/.test(text);
    }) || null;
  }

  // ── Hide messaging ───────────────────────────────────────────────────────
  function hideMessagingPanel() {
    const root = document.getElementById('root');
    if (!root) return;
    const overlayCandidates = collectOverlayCandidates(root);

    [...root.children].forEach(child => {
      if (child.getAttribute('data-lr-hidden')) return;
      const rect = child.getBoundingClientRect();
      const style = window.getComputedStyle(child);
      if (child.tagName === 'SECTION' && rect.height === 0) {
        applyInlineStyle(child, 'display:none!important;');
        child.setAttribute('data-lr-hidden', 'section');
        return;
      }
      if ((style.position === 'fixed' || style.position === 'absolute') &&
          rect.width > 100 && rect.width < window.innerWidth * 0.4) {
        applyInlineStyle(child, 'display:none!important;');
        child.setAttribute('data-lr-hidden', 'overlay');
      }
    });

    // XPath search for "Messaging" text and walk up to container
    const snap = document.evaluate("//text()[contains(., 'Messaging')]", document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < snap.snapshotLength; i++) {
      let el = snap.snapshotItem(i).parentElement;
      for (let d = 0; d < 15 && el && el !== document.body; d++) {
        if (el.getAttribute('data-lr-hidden')) break;
        if (el.id === 'lr-terminal-header' || el.id === 'lr-status-bar') break;
        const rect = el.getBoundingClientRect();
        if (rect.x > window.innerWidth * 0.5 && rect.width > 150 &&
            rect.width < window.innerWidth * 0.4 && rect.height > 200) {
          applyInlineStyle(el, 'display:none!important;');
          el.setAttribute('data-lr-hidden', 'messaging');
          break;
        }
        el = el.parentElement;
      }
    }

    // Also try to hide by looking for right-side absolutely positioned panels
    // that contain "Search messages" or contact names
    overlayCandidates.forEach(el => {
      if (el.getAttribute('data-lr-hidden')) return;
      const rect = el.getBoundingClientRect();
      if (rect.x > window.innerWidth * 0.6 && rect.width > 200 &&
          rect.width < 400 && rect.height > 400) {
        const text = el.innerText || '';
        if (text.includes('Search messages') || text.includes('Messaging')) {
          applyInlineStyle(el, 'display:none!important;');
          el.setAttribute('data-lr-hidden', 'messaging-panel');
        }
      }
    });

    // Hide floating messaging bubble in bottom-right corner
    // It's typically a small (40-80px) fixed element near bottom-right
    overlayCandidates.forEach(el => {
      if (el.getAttribute('data-lr-hidden')) return;
      if (el.closest('#lr-terminal-header') || el.closest('#lr-status-bar')) return;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' &&
          rect.bottom > window.innerHeight - 100 &&
          rect.right > window.innerWidth - 200 &&
          rect.width < 300 && rect.height < 200 &&
          rect.width > 30) {
        applyInlineStyle(el, 'display:none!important;');
        el.setAttribute('data-lr-hidden', 'msg-bubble');
      }
    });
  }

  // ── Media ────────────────────────────────────────────────────────────────
  function processMedia() {
    if (!isEnabled) return;
    const main = document.querySelector('main');
    if (!main) return;

    // Tag headshots — use attribute-based detection since CSS hides images
    // before getBoundingClientRect() can measure them.
    main.querySelectorAll('img:not([data-lr-media-done])').forEach(img => {
      if (img.closest('[data-lr-collapsed="expanded"]')) return;
      if (img.closest('[role="dialog"], [aria-modal="true"]')) return;
      img.setAttribute('data-lr-media-done', 'true');

      const src = img.src || img.getAttribute('src') || '';
      const alt = (img.alt || '').toLowerCase();
      const classes = img.className || '';

      // Method 1: HTML width/height attributes (set before CSS hides them)
      const attrW = parseInt(img.getAttribute('width')) || 0;
      const attrH = parseInt(img.getAttribute('height')) || 0;
      const htmlSmall = (attrW > 0 && attrW <= 100) || (attrH > 0 && attrH <= 100);

      // Method 2: Inline style dimensions
      const inlineStyle = img.getAttribute('style') || '';
      const styleSmall = /width\s*:\s*(\d+)/.test(inlineStyle) &&
                         parseInt(RegExp.$1) <= 100;

      // Method 3: CSS class or attribute hints
      const classHints = /avatar|profile|headshot|presence|member/i.test(classes);
      const parentClasses = (img.parentElement?.className || '') +
                            (img.parentElement?.parentElement?.className || '');
      const parentHints = /avatar|profile|headshot|presence|member|author/i.test(parentClasses);

      // Method 4: Alt text hints
      const altHints = /photo|profile|avatar/i.test(alt) || alt.endsWith("'s photo");

      // Method 5: Image URL patterns for LinkedIn profile images
      const isProfileUrl = src.includes('/profile-displayphoto') ||
                           (!src.includes('/profile-displaybackground') &&
                            src.includes('media.licdn.com/dms/image') &&
                            (src.includes('/C4') || src.includes('/C5') || src.includes('/D4') || src.includes('/D5')));

      // Method 6: Check computed border-radius (may work on some already-visible images)
      let isRound = false;
      try {
        const computed = window.getComputedStyle(img);
        isRound = computed.borderRadius.includes('50') ||
                  computed.borderRadius.includes('9999');
      } catch(e) {}

      // Combine signals — need at least one size hint + one profile hint
      const sizeSignal = htmlSmall || styleSmall || isRound;
      const profileSignal = isProfileUrl || classHints || parentHints || altHints || isRound;

      if (profileSignal && (sizeSignal || isProfileUrl)) {
        img.setAttribute('data-lr-headshot', 'true');
      }
    });

    main.querySelectorAll('video:not([data-lr-hidden]), canvas:not([data-lr-hidden])').forEach(el => {
      if (el.closest('[data-lr-collapsed="expanded"]')) return;
      if (el.closest('[role="dialog"], [aria-modal="true"]')) return;
      applyInlineStyle(el, 'display:none!important;');
      el.setAttribute('data-lr-hidden', 'media');
    });

    collapseMediaContainers(main);
  }

  function collectOverlayCandidates(root) {
    const seen = new Set();
    const candidates = [];

    function add(el) {
      if (!el || seen.has(el) || isReaderOwnedElement(el)) return;
      seen.add(el);
      candidates.push(el);
    }

    [document.body, root].forEach(container => {
      if (!container) return;
      [...container.children].forEach(child => {
        add(child);
        [...child.children].forEach(add);
      });
    });

    return candidates;
  }

  function findDirectChild(parent, selector) {
    return [...parent.children].find(child => child.matches(selector)) || null;
  }

  function setBracketButtonLabel(button, label) {
    button.textContent = '';
    const left = document.createElement('span');
    left.className = 'lr-expand-bracket';
    left.textContent = '[';
    const right = document.createElement('span');
    right.className = 'lr-expand-bracket';
    right.textContent = ']';
    button.append(left, document.createTextNode(` ${label} `), right);
  }

  function ensureMediaControls(el, mediaType) {
    let holder = findDirectChild(el, '[data-lr-media-holder="true"]');
    if (!holder) {
      holder = document.createElement('div');
      holder.setAttribute('data-lr-media-holder', 'true');
      const fragment = document.createDocumentFragment();
      while (el.firstChild) fragment.appendChild(el.firstChild);
      holder.appendChild(fragment);
      el.appendChild(holder);
    }

    let expandBtn = findDirectChild(el, '.lr-expand-media');
    if (!expandBtn) {
      expandBtn = document.createElement('button');
      expandBtn.className = 'lr-expand-media';
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        expandMediaContainer(el);
      });
      el.insertBefore(expandBtn, holder);
    }
    setBracketButtonLabel(expandBtn, `${mediaType} - click to expand`);

    let collapseBtn = findDirectChild(el, '.lr-collapse-media');
    if (!collapseBtn) {
      collapseBtn = document.createElement('button');
      collapseBtn.className = 'lr-collapse-media';
      setBracketButtonLabel(collapseBtn, 'collapse');
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        collapseMediaContainer(el);
      });
      el.insertBefore(collapseBtn, holder);
    }

    return { holder, expandBtn, collapseBtn };
  }

  function collapseMediaContainer(el, mediaType = null) {
    const label = mediaType || el.getAttribute('data-lr-media-label') || 'media';
    el.setAttribute('data-lr-media-label', label);
    const { holder, expandBtn, collapseBtn } = ensureMediaControls(el, label);
    el.setAttribute('data-lr-collapsed', 'media');
    applyInlineStyle(el, 'padding:0!important;min-height:0!important;height:auto!important;overflow:hidden!important;');
    holder.hidden = true;
    expandBtn.hidden = false;
    collapseBtn.hidden = true;
  }

  function expandMediaContainer(el) {
    const holder = findDirectChild(el, '[data-lr-media-holder="true"]');
    const expandBtn = findDirectChild(el, '.lr-expand-media');
    const collapseBtn = findDirectChild(el, '.lr-collapse-media');
    if (!holder || !expandBtn || !collapseBtn) return;

    restoreInlineStyle(el, { preserveSnapshot: true });
    el.setAttribute('data-lr-collapsed', 'expanded');
    holder.hidden = false;
    expandBtn.hidden = true;
    collapseBtn.hidden = false;

    holder.querySelectorAll('video, canvas').forEach(asset => {
      restoreInlineStyle(asset, { preserveSnapshot: true });
    });
  }

  function restoreCollapsedMediaContainers() {
    document.querySelectorAll('[data-lr-collapsed]').forEach(el => {
      const holder = findDirectChild(el, '[data-lr-media-holder="true"]');
      const expandBtn = findDirectChild(el, '.lr-expand-media');
      const collapseBtn = findDirectChild(el, '.lr-collapse-media');

      if (expandBtn) expandBtn.remove();
      if (collapseBtn) collapseBtn.remove();

      if (holder) {
        const fragment = document.createDocumentFragment();
        while (holder.firstChild) fragment.appendChild(holder.firstChild);
        holder.remove();
        el.appendChild(fragment);
      }

      restoreInlineStyle(el);
      el.removeAttribute('data-lr-collapsed');
      el.removeAttribute('data-lr-media-label');
    });
  }

  // ── Collapse media containers into [click to expand] links ──────────────
  // Instead of just hiding empty media boxes, replace them with a compact
  // clickable link that restores the original content when clicked.
  function collapseMediaContainers(root) {
    // Never collapse media on profile pages — profile sections can appear as
    // tall divs without text and would be incorrectly destroyed.
    if (pageType === 'profile' || detectPageType() === 'profile') return;

    root.querySelectorAll('div:not([data-lr-collapsed])').forEach(el => {
      if (el.getAttribute('data-lr-post') || el.getAttribute('data-lr-expanded')) return;
      if (el.closest('#lr-terminal-header') || el.closest('#lr-status-bar')) return;
      if (el.closest('[data-lr-collapsed]')) return; // Parent already collapsed
      if (!el.closest('[data-lr-post="true"]')) return;

      const style = el.getAttribute('style') || '';
      const computed = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      // Detect media containers:
      // 1. Aspect-ratio boxes (padding-bottom percentage)
      // 2. Divs with large min-height and no meaningful text
      // 3. Tall divs (>150px) that contain only hidden media
      const isPaddingBox = style.includes('padding-bottom') || computed.paddingBottom.includes('%');
      const isMinHeight = parseInt(computed.minHeight) > 80;
      const isTallEmpty = rect.height > 150;
      const hasText = el.innerText && el.innerText.trim().length > 15;

      if ((isPaddingBox || isMinHeight || isTallEmpty) && !hasText) {
        // Check if this actually contains media (images, video, carousel links)
        const hasMedia = el.querySelector('img, video, canvas, [class*="carousel"], [class*="image"], [class*="video"]');
        const hasLinks = el.querySelectorAll('a[href]');
        // Detect carousel text labels (like "Lady Arpels Heures Florales")
        const innerLinks = [...hasLinks].filter(a => a.innerText.trim().length > 3);

        // Determine media type label
        let mediaType = 'media';
        if (el.querySelector('video, canvas, [class*="video"]')) mediaType = 'video';
        else if (el.querySelector('[class*="carousel"]') || innerLinks.length > 1) mediaType = 'carousel';
        else if (el.querySelector('img') || hasMedia) mediaType = 'image';
        if (innerLinks.length > 0) {
          // Has link text — probably carousel labels
          const labels = innerLinks.map(a => a.innerText.trim()).filter(t => t.length > 0).slice(0, 3);
          if (labels.length > 0) {
            mediaType = labels.join(' · ');
          }
        }

        collapseMediaContainer(el, mediaType);
      }
    });
  }

  // ── Tag posts ────────────────────────────────────────────────────────────
  function tagPosts() {
    if (!isEnabled) return;
    const main = document.querySelector('main');
    if (!main) return;
    const allowTallPostContainers = isSinglePostPage();

    // Primary strategy: Find posts by "Like" button text — most reliable
    // A real post always has Like + Comment buttons.
    const actionControls = main.querySelectorAll('button, [role="button"]');
    actionControls.forEach(btn => {
      if (!isLikeActionControl(btn)) return;

      // Walk up to find the post container
      let el = btn.parentElement;
      for (let i = 0; i < 12 && el && el !== main; i++) {
        if (el.getAttribute('data-lr-post')) break; // Already tagged

        const rect = el.getBoundingClientRect();
        // Post must be reasonably sized
        if (rect.width < 300 || rect.height < 100) { el = el.parentElement; continue; }

        const { hasLike, hasComment, hasShare } = hasRequiredPostActions(el);

        // Need at least Like + Comment, but tolerate mobile/share-only variants.
        if (hasLike && (hasComment || hasShare)) {
          // Verify it's not a "Start a post" box or navigation
          const innerText = el.innerText || '';
          if (looksLikeNonPostComposer(innerText)) {
            break; // Skip this — it's not a real post
          }

          // Make sure we're not tagging the entire feed or a too-large container
          if (!allowTallPostContainers && rect.height > window.innerHeight * 2) {
            el = el.parentElement;
            continue;
          }

          const parentPost = el.parentElement?.closest('[data-lr-post]');
          if (!parentPost) {
            const taggedPost = allowTallPostContainers ? promoteSinglePostContainer(el, main) : el;
            taggedPost.setAttribute('data-lr-post', 'true');
            break;
          }
        }
        el = el.parentElement;
      }
    });

    if (!main.querySelector('[data-lr-post="true"]')) {
      const taggedFallbacks = [];
      const fallbackCandidates = [...main.querySelectorAll('article, section, div')]
        .filter(el => !el.getAttribute('data-lr-post'))
        .map(el => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || '').trim();
          const actions = hasRequiredPostActions(el);
          return { el, rect, text, actions };
        })
        .filter(({ rect, text, actions }) => {
          if (rect.width < 260 || rect.height < 120) return false;
          if (rect.height > window.innerHeight * 2.5 && !allowTallPostContainers) return false;
          if (looksLikeNonPostComposer(text)) return false;
          if (text.length < 40) return false;
          return actions.hasLike && (actions.hasComment || actions.hasShare);
        })
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);

      fallbackCandidates.forEach(({ el }) => {
        if (taggedFallbacks.some(tagged => tagged === el || tagged.contains(el) || el.contains(tagged))) return;
        const taggedPost = allowTallPostContainers ? promoteSinglePostContainer(el, main) : el;
        taggedPost.setAttribute('data-lr-post', 'true');
        taggedFallbacks.push(taggedPost);
      });
    }

    // Single-post permalinks often render the primary article as a tall detail view.
    // If the regular feed heuristics miss it, fall back to the first viable tall candidate.
    if (allowTallPostContainers && !main.querySelector('[data-lr-post="true"]')) {
      const candidates = [...main.querySelectorAll('article, section, div')]
        .filter(el => !el.getAttribute('data-lr-post'))
        .map(el => ({
          el,
          rect: el.getBoundingClientRect(),
          buttonTexts: getActionLabels(el)
        }))
        .filter(({ rect, buttonTexts }) => {
          if (rect.width < 300 || rect.height < 120) return false;
          const hasLike = buttonTexts.some(text => text === 'like' || text === 'react' || text.includes('like'));
          const hasComment = buttonTexts.some(text => text === 'comment' || text.includes('comment'));
          const hasShare = buttonTexts.some(text => text.includes('share') || text.includes('repost') || text.includes('send'));
          return hasLike && (hasComment || hasShare);
        })
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);

      const primaryPost = candidates[0]?.el;
      if (primaryPost) primaryPost.setAttribute('data-lr-post', 'true');
    }

    if (allowTallPostContainers && !main.querySelector('[data-lr-post="true"]')) {
      const detailCandidates = [...main.querySelectorAll('article, section, div')]
        .filter(el => !el.getAttribute('data-lr-post'))
        .filter(el => looksLikeSinglePostDetailCandidate(el, main))
        .sort((a, b) => {
          const scoreDiff = scoreSinglePostDetailCandidate(b, main) - scoreSinglePostDetailCandidate(a, main);
          if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
          return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
        });

      const primaryPost = detailCandidates[0];
      if (primaryPost) {
        const promoted = promoteSinglePostContainer(primaryPost, main);
        promoted.setAttribute('data-lr-post', 'true');
      }
    }
  }

  function isInterestingMutationNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.trim().length > 0;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node;
    if (isReaderOwnedElement(el)) return false;
    if (el.matches('script, style, link, noscript')) return false;
    if (el.closest?.('#lr-terminal-header, #lr-status-bar, #lr-topic-overlay')) return false;
    return true;
  }

  function mutationNeedsLayoutRefresh(node, target) {
    const el = node?.nodeType === Node.ELEMENT_NODE
      ? node
      : target?.nodeType === Node.ELEMENT_NODE
        ? target
        : null;
    if (!el || isReaderOwnedElement(el)) return false;
    if (el.matches?.('main, aside, section, article, nav')) return true;
    if (el.querySelector?.('main, aside, section, article, nav')) return true;

    let current = el;
    for (let depth = 0; current && depth < 3; depth++, current = current.parentElement) {
      if (current.tagName === 'MAIN' || current.id === 'root') return true;
    }
    return false;
  }

  function analyzeMutations(mutations) {
    let relevant = false;
    let layout = false;

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      const nodes = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes];

      for (const node of nodes) {
        if (!isInterestingMutationNode(node)) continue;
        relevant = true;
        if (mutationNeedsLayoutRefresh(node, mutation.target)) {
          layout = true;
        }
        break;
      }

      if (relevant && layout) break;
    }

    return { relevant, layout };
  }

  function scheduleObserverRefresh(needsLayout) {
    observerNeedsLayoutRefresh = observerNeedsLayoutRefresh || needsLayout;
    if (observerTimer) return;

    const sinceLastRefresh = Date.now() - lastObserverRefreshAt;
    const delay = sinceLastRefresh > 500 ? 180 : Math.max(180, 500 - sinceLastRefresh);
    observerTimer = setTimeout(() => {
      observerTimer = null;
      const fullLayout = observerNeedsLayoutRefresh;
      observerNeedsLayoutRefresh = false;
      lastObserverRefreshAt = Date.now();

      if (!isEnabled) return;

      // Re-check page type on every refresh — LinkedIn SPA may have navigated
      // between feed and profile before the URL-change poller caught up.
      const currentPageType = detectPageType();
      if (currentPageType !== pageType) {
        // Page type changed under us — full reinit
        disable();
        enable();
        return;
      }

      if (pageType === 'profile') {
        restructureProfilePage({ fullLayout });
      } else {
        restructurePage({ fullLayout });
        collectPosts();
        maybeAutoSelectFirstPost();
      }
    }, delay);
  }

  // ── Observer ─────────────────────────────────────────────────────────────
  function startObserver() {
    if (mutationObserver) return;
    observerNeedsLayoutRefresh = false;
    lastObserverRefreshAt = 0;
    mutationObserver = new MutationObserver((mutations) => {
      const analysis = analyzeMutations(mutations);
      if (!analysis.relevant) return;
      scheduleObserverRefresh(analysis.layout);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observerTimer) {
      clearTimeout(observerTimer);
      observerTimer = null;
    }
    observerNeedsLayoutRefresh = false;
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
  }

  // ── Messages ─────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.action === 'toggle') {
      isEnabled ? disable() : enable();
      setState(isEnabled);
      respond({ enabled: isEnabled });
    } else if (msg.action === 'getState') {
      respond({ enabled: isEnabled });
    }
    return true;
  });

  // ── Keyboard: Alt+Shift+L (when not in text mode, to enable) ────────────
  document.addEventListener('keydown', e => {
    if (!isEnabled && e.altKey && e.shiftKey && e.key === 'L') {
      enable();
      setState(true);
    }
  });

  // ── URL change detection (LinkedIn SPA navigation) ──────────────────────
  let lastUrl = window.location.href;

  function checkUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (isEnabled) {
        disable();
        enable();
      }
    }
  }

  // Poll for URL changes (LinkedIn doesn't fire popstate reliably)
  setInterval(checkUrlChange, 500);

  // Also listen for popstate/pushstate
  window.addEventListener('popstate', () => setTimeout(checkUrlChange, 100));
  const origPushState = history.pushState;
  history.pushState = function() {
    origPushState.apply(this, arguments);
    setTimeout(checkUrlChange, 100);
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    setTimeout(checkUrlChange, 100);
  };

  // ── Init ─────────────────────────────────────────────────────────────────
  getState(enabled => {
    if (!enabled) return;
    const tryInit = () => {
      if (document.querySelector('main')) {
        enable();
      } else {
        const iv = setInterval(() => {
          if (document.querySelector('main')) { clearInterval(iv); enable(); }
        }, 300);
        setTimeout(() => clearInterval(iv), 10000);
      }
    };
    if (document.readyState === 'complete') tryInit();
    else window.addEventListener('load', tryInit);
  });
})();
