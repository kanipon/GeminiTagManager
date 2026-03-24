(function () {
  "use strict";

  const groupsEl = document.getElementById("groups");
  const searchEl = document.getElementById("search");
  const statusEl = document.getElementById("status");

  let allChats = [];
  let draggedChat = null;

  // Geminiタブにメッセージを送信
  async function sendToContent(msg) {
    const [tab] = await chrome.tabs.query({
      url: "https://gemini.google.com/*",
    });
    if (!tab) return null;
    return chrome.tabs.sendMessage(tab.id, msg);
  }

  // チャットデータ取得
  async function loadChats() {
    const res = await sendToContent({ type: "getChats" });
    if (!res || !res.chats) {
      statusEl.textContent = "Geminiのタブを開いてください";
      return;
    }
    allChats = res.chats;
    statusEl.textContent = allChats.length + "件のチャット";
    render();
  }

  // グループ化（複数タグ対応：複数グループに表示）
  function groupChats(chats) {
    const groups = {};
    for (const chat of chats) {
      const tags = chat.tags && chat.tags.length > 0 ? chat.tags : ["未分類"];
      for (const tag of tags) {
        if (!groups[tag]) groups[tag] = [];
        groups[tag].push(chat);
      }
    }
    // ソート: 未分類は最後
    const sorted = Object.entries(groups).sort((a, b) => {
      if (a[0] === "未分類") return 1;
      if (b[0] === "未分類") return -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  }

  // フィルタ
  function filterChats(chats, query) {
    if (!query) return chats;
    const q = query.toLowerCase();
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }

  // 描画
  function render() {
    const query = searchEl.value.trim();
    const filtered = filterChats(allChats, query);
    const groups = groupChats(filtered);

    groupsEl.textContent = "";

    for (const [tag, chats] of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "group";
      groupEl.dataset.tag = tag;

      // ヘッダー
      const header = document.createElement("div");
      header.className = "group-header";

      const nameSpan = document.createElement("span");
      nameSpan.className = "group-name";
      nameSpan.textContent = tag;

      const countSpan = document.createElement("span");
      countSpan.className = "group-count";
      countSpan.textContent = chats.length;

      header.appendChild(nameSpan);
      header.appendChild(countSpan);
      header.addEventListener("click", () => {
        itemsEl.classList.toggle("collapsed");
      });

      groupEl.appendChild(header);

      // アイテム一覧
      const itemsEl = document.createElement("div");
      itemsEl.className = "group-items";

      // ドロップゾーン
      itemsEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      itemsEl.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!draggedChat) return;
        const newTag = tag === "未分類" ? null : tag;
        handleTagChange(draggedChat.chatId, newTag);
        draggedChat = null;
      });

      for (const chat of chats) {
        const item = createChatItem(chat);
        itemsEl.appendChild(item);
      }

      groupEl.appendChild(itemsEl);
      groupsEl.appendChild(groupEl);
    }
  }

  function createChatItem(chat) {
    const item = document.createElement("div");
    item.className = "chat-item";
    if (chat.hidden) item.classList.add("hidden-chat");
    item.draggable = true;

    // ドラッグハンドル
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "\u2630";

    // タイトル
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title;
    title.title = chat.title;

    // アクション
    const actions = document.createElement("span");
    actions.className = "chat-actions";

    if (chat.hidden) {
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "restore-btn";
      restoreBtn.textContent = "復元";
      restoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleVisibility(chat.chatId, false);
      });
      actions.appendChild(restoreBtn);
    } else {
      const hideBtn = document.createElement("button");
      hideBtn.className = "hide-btn";
      hideBtn.textContent = "\u00D7";
      hideBtn.title = "非表示";
      hideBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleVisibility(chat.chatId, true);
      });
      actions.appendChild(hideBtn);
    }

    item.appendChild(handle);
    item.appendChild(title);
    item.appendChild(actions);

    // ドラッグイベント
    item.addEventListener("dragstart", (e) => {
      draggedChat = chat;
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      draggedChat = null;
      document.querySelectorAll(".drag-over").forEach((el) => {
        el.classList.remove("drag-over");
      });
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("drag-over");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("drag-over");
      if (!draggedChat || draggedChat.chatId === chat.chatId) return;
      // ドロップ先のグループにタグを変更
      const newTag = chat.tags && chat.tags.length > 0 ? chat.tags[0] : null;
      handleTagChange(draggedChat.chatId, newTag);
      draggedChat = null;
    });

    return item;
  }

  async function handleTagChange(chatId, tag) {
    await sendToContent({ type: "setTag", chatId, tag });
    // ローカルデータも更新
    const chat = allChats.find((c) => c.chatId === chatId);
    if (chat) chat.tags = tag ? [tag] : [];
    render();
  }

  async function handleVisibility(chatId, hidden) {
    await sendToContent({ type: "setHidden", chatId, hidden });
    const chat = allChats.find((c) => c.chatId === chatId);
    if (chat) chat.hidden = hidden;
    render();
  }

  // 検索
  searchEl.addEventListener("input", () => render());

  // 初期化
  loadChats();
})();
