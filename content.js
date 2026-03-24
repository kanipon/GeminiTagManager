(function () {
  "use strict";

  const TAG_REGEX = /^\[([^\]]+)\]/;
  const FILTER_CONTAINER_ID = "gco-filter-container";
  const STORAGE_KEY = "gco-custom-tags";
  const HIDDEN_KEY = "gco-hidden-chats";
  const POLL_INTERVAL = 2000;

  let currentFilter = null; // null = すべて表示
  let searchQuery = ""; // 検索クエリ
  let showHidden = false; // 非表示チャットの表示トグル

  // --- メモリキャッシュ + chrome.storage.sync ---
  let cachedCustomTags = {};
  let cachedHiddenChats = {};
  let storageReady = false;

  // 起動時にsyncからロード（localStorageからの移行も行う）
  function loadStorage(callback) {
    chrome.storage.sync.get([STORAGE_KEY, HIDDEN_KEY], (result) => {
      cachedCustomTags = result[STORAGE_KEY] || {};
      cachedHiddenChats = result[HIDDEN_KEY] || {};

      // localStorageからの移行
      try {
        const localTags = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        const localHidden =
          JSON.parse(localStorage.getItem(HIDDEN_KEY)) || {};
        let migrated = false;

        if (Object.keys(localTags).length > 0) {
          Object.assign(cachedCustomTags, localTags);
          localStorage.removeItem(STORAGE_KEY);
          migrated = true;
        }
        if (Object.keys(localHidden).length > 0) {
          Object.assign(cachedHiddenChats, localHidden);
          localStorage.removeItem(HIDDEN_KEY);
          migrated = true;
        }
        if (migrated) {
          saveStorage();
        }
      } catch {
        // 移行失敗は無視
      }

      storageReady = true;
      callback();
    });
  }

  const SYNC_QUOTA = 102400; // chrome.storage.sync の合計上限 (100KB)
  const WARN_THRESHOLD = 0.8; // 80%で警告

  function saveStorage() {
    const data = {
      [STORAGE_KEY]: cachedCustomTags,
      [HIDDEN_KEY]: cachedHiddenChats,
    };
    chrome.storage.sync.set(data, () => {
      if (chrome.runtime.lastError) {
        showStorageWarning("保存に失敗しました: " + chrome.runtime.lastError.message);
        return;
      }
      // 使用量チェック
      chrome.storage.sync.getBytesInUse(null, (bytes) => {
        const ratio = bytes / SYNC_QUOTA;
        if (ratio >= WARN_THRESHOLD) {
          const pct = Math.round(ratio * 100);
          showStorageWarning(
            "ストレージ使用量: " + pct + "% (" +
            Math.round(bytes / 1024) + "KB / 100KB)\n" +
            "不要な非表示チャットを復元するか、タグを整理してください"
          );
        } else {
          hideStorageWarning();
        }
      });
    });
  }

  function showStorageWarning(msg) {
    let warn = document.getElementById("gco-storage-warning");
    if (!warn) {
      warn = document.createElement("div");
      warn.id = "gco-storage-warning";
      const container = document.getElementById(FILTER_CONTAINER_ID);
      if (container) {
        container.parentElement.insertBefore(warn, container.nextSibling);
      }
    }
    warn.textContent = msg;
  }

  function hideStorageWarning() {
    const warn = document.getElementById("gco-storage-warning");
    if (warn) warn.remove();
  }

  // 他デバイスからの同期変更を反映
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes[STORAGE_KEY]) {
      cachedCustomTags = changes[STORAGE_KEY].newValue || {};
      update();
    }
    if (changes[HIDDEN_KEY]) {
      cachedHiddenChats = changes[HIDDEN_KEY].newValue || {};
      update();
    }
  });

  function getCustomTags() {
    return cachedCustomTags;
  }

  function setCustomTag(chatId, tag) {
    if (tag) {
      cachedCustomTags[chatId] = tag;
    } else {
      delete cachedCustomTags[chatId];
    }
    saveStorage();
  }

  function getHiddenChats() {
    return cachedHiddenChats;
  }

  function setHiddenChat(chatId, hidden) {
    if (hidden) {
      cachedHiddenChats[chatId] = true;
    } else {
      delete cachedHiddenChats[chatId];
    }
    saveStorage();
  }

  // チャットIDをhrefから取得
  function getChatId(el) {
    const href = el.getAttribute("href") || "";
    return href.replace(/^\/app\//, "");
  }

  // タイトル先頭の連続する[タグ]をすべて抽出
  function parseTags(title) {
    const tags = [];
    let remaining = title;
    let m;
    while ((m = remaining.match(TAG_REGEX))) {
      tags.push(m[1]);
      remaining = remaining.slice(m[0].length);
    }
    return tags;
  }

  // チャット要素からタグとタイトルをパース
  function parseConversation(el) {
    const titleEl = el.querySelector(".conversation-title");
    const raw = titleEl
      ? titleEl.textContent.trim()
      : el.textContent.replace(/固定したチャット$/, "").trim();
    const chatId = getChatId(el);
    const originalTags = parseTags(raw);

    // カスタムタグがあればそちらを優先（カンマ区切りで複数対応）
    const customTags = getCustomTags();
    const customTag = customTags[chatId];

    let tags;
    if (customTag !== undefined) {
      tags = customTag ? customTag.split(",").map((t) => t.trim()) : [];
    } else {
      tags = originalTags;
    }

    return {
      el,
      chatId,
      tags,
      originalTags,
      title: raw,
    };
  }

  // すべてのチャット要素を取得してパース
  function getAllConversations() {
    const links = document.querySelectorAll("a.conversation");
    return Array.from(links).map(parseConversation);
  }

  // タグ一覧を集計（非表示チャットは除外）
  function collectTags(conversations) {
    const hidden = getHiddenChats();
    const tags = {};
    for (const c of conversations) {
      if (hidden[c.chatId]) continue;
      if (c.tags.length === 0) {
        tags["未分類"] = (tags["未分類"] || 0) + 1;
      } else {
        for (const t of c.tags) {
          tags[t] = (tags[t] || 0) + 1;
        }
      }
    }
    const sorted = Object.entries(tags).sort((a, b) => {
      if (a[0] === "未分類") return 1;
      if (b[0] === "未分類") return -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  }

  // 既存タグ一覧を取得（入力補完用）
  function getExistingTags(conversations) {
    const tagSet = new Set();
    for (const c of conversations) {
      for (const t of c.tags) tagSet.add(t);
    }
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }

  // --- タグ編集ポップアップ ---

  function showTagEditor(chatId, currentTag, anchorEl) {
    closeTagEditor();

    const popup = document.createElement("div");
    popup.id = "gco-tag-editor";

    const existingTags = getExistingTags(getAllConversations());

    const input = document.createElement("input");
    input.type = "text";
    input.className = "gco-tag-input";
    input.value = currentTag || "";
    input.placeholder = "タグを入力...";
    popup.appendChild(input);

    if (existingTags.length > 0) {
      const suggest = document.createElement("div");
      suggest.className = "gco-tag-suggest";
      for (const tag of existingTags) {
        const item = document.createElement("button");
        item.className = "gco-tag-suggest-item";
        if (tag === currentTag) item.classList.add("gco-tag-suggest-active");
        item.textContent = tag;
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          input.value = tag;
          saveAndClose();
        });
        suggest.appendChild(item);
      }
      popup.appendChild(suggest);
    }

    const actions = document.createElement("div");
    actions.className = "gco-tag-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "gco-tag-save";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      saveAndClose();
    });

    const clearBtn = document.createElement("button");
    clearBtn.className = "gco-tag-clear";
    clearBtn.textContent = "タグ解除";
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setCustomTag(chatId, null);
      closeTagEditor();
      update();
    });

    actions.appendChild(clearBtn);
    actions.appendChild(saveBtn);
    popup.appendChild(actions);

    function saveAndClose() {
      const val = input.value.trim();
      if (val) {
        setCustomTag(chatId, val);
      }
      closeTagEditor();
      update();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveAndClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeTagEditor();
      }
    });

    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = rect.bottom + 4 + "px";
    popup.style.left = rect.left + "px";

    document.body.appendChild(popup);

    setTimeout(() => {
      document.addEventListener("click", onClickOutside);
    }, 0);

    input.focus();
  }

  function onClickOutside(e) {
    const editor = document.getElementById("gco-tag-editor");
    if (editor && !editor.contains(e.target)) {
      closeTagEditor();
    }
  }

  function closeTagEditor() {
    const editor = document.getElementById("gco-tag-editor");
    if (editor) editor.remove();
    document.removeEventListener("click", onClickOutside);
  }

  // --- チャット項目にタグ編集ボタンを付与 ---

  function attachTagEditButtons(conversations) {
    for (const c of conversations) {
      const entry = c.el.closest(".side-nav-entry-container") || c.el;

      if (entry.querySelector(".gco-edit-tag-btn")) continue;

      entry.style.position = "relative";

      const tagBtn = document.createElement("button");
      tagBtn.className = "gco-edit-tag-btn";
      tagBtn.title = "タグを編集";
      tagBtn.textContent = "\u{1F3F7}";
      tagBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTagEditor(c.chatId, c.tags.join(", "), tagBtn);
      });
      entry.appendChild(tagBtn);

      const hideBtn = document.createElement("button");
      hideBtn.className = "gco-hide-btn";
      hideBtn.title = "このチャットを非表示";
      hideBtn.textContent = "\u00D7";
      hideBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setHiddenChat(c.chatId, true);
        update();
      });
      entry.appendChild(hideBtn);
    }
  }

  // 検索UIを作成（フィルタコンテナの前に挿入）
  function renderSearchUI(filterContainer) {
    let searchContainer = document.getElementById("gco-search-container");
    if (searchContainer) return;

    searchContainer = document.createElement("div");
    searchContainer.id = "gco-search-container";

    const input = document.createElement("input");
    input.type = "text";
    input.id = "gco-search-input";
    input.placeholder = "チャットを検索...";
    input.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      update();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        searchQuery = "";
        update();
        input.blur();
      }
    });

    const clearBtn = document.createElement("button");
    clearBtn.id = "gco-search-clear";
    clearBtn.textContent = "✕";
    clearBtn.addEventListener("click", () => {
      input.value = "";
      searchQuery = "";
      update();
    });

    searchContainer.appendChild(input);
    searchContainer.appendChild(clearBtn);

    filterContainer.parentElement.insertBefore(
      searchContainer,
      filterContainer
    );
  }

  // フィルタUIを作成・更新
  function renderFilterUI(tags) {
    let container = document.getElementById(FILTER_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = FILTER_CONTAINER_ID;

      const historyTitle = document.querySelector(
        ".ng-trigger-conversationListTitleVisibilityAnimation"
      );
      if (historyTitle) {
        historyTitle.parentElement.insertBefore(
          container,
          historyTitle.nextSibling
        );
      } else {
        const chatHistory = document.querySelector(".chat-history");
        if (chatHistory) {
          chatHistory.prepend(container);
        } else {
          return;
        }
      }
    }

    renderSearchUI(container);

    const totalCount = tags.reduce((sum, [, count]) => sum + count, 0);

    container.innerHTML = "";

    const allBtn = createTagButton("すべて", totalCount, null);
    container.appendChild(allBtn);

    for (const [tag, count] of tags) {
      const btn = createTagButton(tag, count, tag);
      container.appendChild(btn);
    }

    const hiddenCount = Object.keys(getHiddenChats()).length;
    if (hiddenCount > 0) {
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "gco-tag-btn gco-hidden-toggle";
      if (showHidden) toggleBtn.classList.add("gco-tag-active");
      const label = showHidden ? "非表示を隠す" : "非表示を表示";
      toggleBtn.textContent = label + " " + hiddenCount;
      toggleBtn.addEventListener("click", () => {
        showHidden = !showHidden;
        update();
      });
      container.appendChild(toggleBtn);
    }
  }

  function createTagButton(label, count, filterValue) {
    const btn = document.createElement("button");
    btn.className = "gco-tag-btn";
    if (
      currentFilter === filterValue ||
      (currentFilter === null && filterValue === null)
    ) {
      btn.classList.add("gco-tag-active");
    }
    btn.innerHTML = `<span class="gco-tag-label">${label}</span><span class="gco-tag-count">${count}</span>`;
    btn.addEventListener("click", () => {
      currentFilter = filterValue;
      update();
    });
    return btn;
  }

  // フィルタ適用
  function applyFilter(conversations) {
    const hidden = getHiddenChats();
    for (const c of conversations) {
      const entry = c.el.closest(".side-nav-entry-container") || c.el;

      if (hidden[c.chatId]) {
        if (showHidden) {
          entry.style.display = "";
          entry.classList.add("gco-hidden-chat");
          if (!entry.querySelector(".gco-restore-btn")) {
            const restoreBtn = document.createElement("button");
            restoreBtn.className = "gco-restore-btn";
            restoreBtn.textContent = "復元";
            restoreBtn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              setHiddenChat(c.chatId, false);
              update();
            });
            entry.appendChild(restoreBtn);
          }
          continue;
        }
        entry.style.display = "none";
        continue;
      }
      entry.classList.remove("gco-hidden-chat");
      const oldRestore = entry.querySelector(".gco-restore-btn");
      if (oldRestore) oldRestore.remove();

      if (searchQuery && !c.title.toLowerCase().includes(searchQuery)) {
        entry.style.display = "none";
        continue;
      }

      if (currentFilter === null) {
        entry.style.display = "";
      } else if (currentFilter === "未分類") {
        entry.style.display = c.tags.length === 0 ? "" : "none";
      } else {
        entry.style.display = c.tags.includes(currentFilter) ? "" : "none";
      }
    }
  }

  // メイン更新処理
  let updating = false;
  function update() {
    if (updating || !storageReady) return;
    updating = true;
    try {
      const conversations = getAllConversations();
      if (conversations.length === 0) return;

      const tags = collectTags(conversations);
      renderFilterUI(tags);
      applyFilter(conversations);
      attachTagEditButtons(conversations);
    } finally {
      updating = false;
    }
  }

  // DOM変更を監視して自動更新（デバウンス付き）
  function startObserver() {
    const target = document.querySelector(
      ".chat-history, .sidenav-with-history-container"
    );
    if (target) {
      let debounceTimer = null;
      const observer = new MutationObserver((mutations) => {
        if (updating) return;
        const isOwnChange = mutations.every((m) => {
          const t = m.target;
          return (
            t.id?.startsWith("gco-") ||
            t.closest?.("#gco-filter-container") ||
            t.closest?.("#gco-search-container") ||
            t.closest?.(".gco-edit-tag-btn")
          );
        });
        if (isOwnChange) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(update, 300);
      });
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  // 初期化: まずsyncストレージをロード、次にDOM待機
  function init() {
    loadStorage(() => {
      const interval = setInterval(() => {
        const conversations = document.querySelectorAll("a.conversation");
        if (conversations.length > 0) {
          clearInterval(interval);
          update();
          startObserver();
        }
      }, POLL_INTERVAL);
    });
  }

  // --- popup との通信 ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "getChats") {
      const conversations = getAllConversations();
      const hidden = getHiddenChats();
      const data = conversations.map((c) => ({
        chatId: c.chatId,
        title: c.title,
        tags: c.tags,
        originalTags: c.originalTags,
        hidden: !!hidden[c.chatId],
        href: c.el.getAttribute("href"),
      }));
      sendResponse({ chats: data });
    } else if (msg.type === "setTag") {
      setCustomTag(msg.chatId, msg.tag);
      update();
      sendResponse({ ok: true });
    } else if (msg.type === "setHidden") {
      setHiddenChat(msg.chatId, msg.hidden);
      update();
      sendResponse({ ok: true });
    } else if (msg.type === "bulkSetTags") {
      for (const { chatId, tag } of msg.items) {
        setCustomTag(chatId, tag);
      }
      update();
      sendResponse({ ok: true });
    }
    return true;
  });

  init();
})();
