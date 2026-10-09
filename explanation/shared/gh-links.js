/* gh-links.js — コードシンボル/ファイル名を GitHub ソースへリンクする。
 * 使い方: <script src="…/gh-links.js"></script> を読み込むだけで、
 * DOMContentLoaded 時にページ中の <code> 要素を走査し、SYMS に登録された
 * Go シンボル (または *.go ファイル名) を github.com の該当行への
 * ハイパーリンクで包む。
 *
 * リンク形式: https://github.com/<repo>/blob/master/<path>#L<行番号>
 */
"use strict";
(function () {
  const GH_BLOB =
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/";
  const GH_TREE =
    "https://github.com/ryogrid/concurrent-bp-tree/tree/master/";

  function ghURL(file, line) {
    return GH_BLOB + file + (line ? "#L" + line : "");
  }

  // シンボル → [ファイル, 行] (行=0 はファイルへのリンクのみ)
  const SYMS = {
    // tree.go
    Open: ["bptree/tree.go", 36], initEmpty: ["bptree/tree.go", 79],
    writeMeta: ["bptree/tree.go", 101], Close: ["bptree/tree.go", 123],
    errRestart: ["bptree/tree.go", 150], retryOp: ["bptree/tree.go", 157],
    allocPageRetry: ["bptree/tree.go", 175],
    fetchRetry: ["bptree/tree.go", 186], heldStack: ["bptree/tree.go", 199],
    releaseHeld: ["bptree/tree.go", 204], release: ["bptree/tree.go", 214],
    acquireOp: ["bptree/tree.go", 220], releaseOp: ["bptree/tree.go", 224],
    Get: ["bptree/tree.go", 229], get: ["bptree/tree.go", 245],
    Put: ["bptree/tree.go", 281], put: ["bptree/tree.go", 297],
    Delete: ["bptree/tree.go", 471],
    delete: ["bptree/tree.go", 491], del: ["bptree/tree.go", 491],
    RangeScan: ["bptree/tree.go", 736], rangeScan: ["bptree/tree.go", 754],
    rootMu: ["bptree/tree.go", 26], metaMu: ["bptree/tree.go", 27],
    "rootMu.RLock": ["bptree/tree.go", 26],
    "rootMu.RUnlock": ["bptree/tree.go", 26],
    "metaMu.Lock": ["bptree/tree.go", 27],
    "metaMu.Unlock": ["bptree/tree.go", 27],
    opSlots: ["bptree/tree.go", 29],
    TryLock: ["bptree/tree.go", 678],
    "sib.latch.TryLock": ["bptree/tree.go", 678],
    // node.go
    nodeCount: ["bptree/node.go", 16], isLeaf: ["bptree/node.go", 19],
    safeForInsert: ["bptree/node.go", 22],
    safeForDelete: ["bptree/node.go", 30],
    leafInit: ["bptree/node.go", 42], leafNext: ["bptree/node.go", 48],
    leafSetNext: ["bptree/node.go", 49], nextLeafPID: ["bptree/node.go", 10],
    leafKey: ["bptree/node.go", 51], leafVal: ["bptree/node.go", 52],
    leafSetPair: ["bptree/node.go", 54], leafFindPos: ["bptree/node.go", 61],
    leafInsertAt: ["bptree/node.go", 77], leafRemoveAt: ["bptree/node.go", 87],
    leafInsertSplit: ["bptree/node.go", 104],
    leafMergeInto: ["bptree/node.go", 135],
    leafBorrowFromRight: ["bptree/node.go", 146],
    leafBorrowFromLeft: ["bptree/node.go", 156],
    internalInit: ["bptree/node.go", 165],
    internalKey: ["bptree/node.go", 171],
    internalChild: ["bptree/node.go", 172],
    internalSetKey: ["bptree/node.go", 173],
    internalSetChild: ["bptree/node.go", 174],
    internalFindChildIdx: ["bptree/node.go", 178],
    internalInitRoot: ["bptree/node.go", 194],
    internalInsertKeyAt: ["bptree/node.go", 204],
    internalRemoveKeyAt: ["bptree/node.go", 216],
    internalInsertSplit: ["bptree/node.go", 230],
    internalMergeInto: ["bptree/node.go", 275],
    internalBorrowFromRight: ["bptree/node.go", 290],
    internalBorrowFromLeft: ["bptree/node.go", 311],
    // const.go
    PageSize: ["bptree/const.go", 6], BufferPoolFrames: ["bptree/const.go", 13],
    MaxTreeHeight: ["bptree/const.go", 17],
    MaxInternalKeys: ["bptree/const.go", 30],
    MinInternalKeys: ["bptree/const.go", 31],
    MaxLeafPairs: ["bptree/const.go", 32],
    MinLeafPairs: ["bptree/const.go", 33],
    metaPageID: ["bptree/const.go", 44], nilPageID: ["bptree/const.go", 47],
    ErrNoFreeFrame: ["bptree/const.go", 54],
    ErrMaxTreeHeight: ["bptree/const.go", 56],
    ErrCorruptFile: ["bptree/const.go", 58], ErrClosed: ["bptree/const.go", 60],
    // buffer.go
    frame: ["bptree/buffer.go", 11], bufferPool: ["bptree/buffer.go", 20],
    BufferPool: ["bptree/buffer.go", 20],
    newBufferPool: ["bptree/buffer.go", 28],
    fetch: ["bptree/buffer.go", 42], "pool.fetch": ["bptree/buffer.go", 42],
    unpin: ["bptree/buffer.go", 89], flushAll: ["bptree/buffer.go", 103],
    latch: ["bptree/buffer.go", 16], lastUsed: ["bptree/buffer.go", 15],
    "f.latch.RLock": ["bptree/buffer.go", 16],
    "f.latch.RUnlock": ["bptree/buffer.go", 16],
    "cf.latch.Lock": ["bptree/buffer.go", 16],
    RLock: ["bptree/buffer.go", 16], RUnlock: ["bptree/buffer.go", 16],
    // disk.go
    diskManager: ["bptree/disk.go", 10], DiskManager: ["bptree/disk.go", 10],
    openDisk: ["bptree/disk.go", 14], readPage: ["bptree/disk.go", 22],
    writePage: ["bptree/disk.go", 39],
    // meta.go
    meta: ["bptree/meta.go", 15], "meta.rootPageID": ["bptree/meta.go", 16],
    encodeMeta: ["bptree/meta.go", 22], decodeMeta: ["bptree/meta.go", 31],
    freeListHead: ["bptree/meta.go", 18], nextPageID: ["bptree/meta.go", 19],
    height: ["bptree/meta.go", 17],
    // freelist.go
    allocPage: ["bptree/freelist.go", 43],
    freePage: ["bptree/freelist.go", 50],
    allocPageLocked: ["bptree/freelist.go", 13],
    freePageLocked: ["bptree/freelist.go", 31],
    // types.go / page.go
    PageID: ["bptree/types.go", 4], Pair: ["bptree/types.go", 7],
    getI64: ["bptree/page.go", 8], setI64: ["bptree/page.go", 12],
    // ファイル名そのもの (行番号なし)
    "tree.go": ["bptree/tree.go", 0], "node.go": ["bptree/node.go", 0],
    "const.go": ["bptree/const.go", 0], "buffer.go": ["bptree/buffer.go", 0],
    "disk.go": ["bptree/disk.go", 0], "meta.go": ["bptree/meta.go", 0],
    "freelist.go": ["bptree/freelist.go", 0], "page.go": ["bptree/page.go", 0],
    "types.go": ["bptree/types.go", 0],
    // リポジトリ内の非 .go パス (tree ビュー / blob 直リンク)
    "bptree": ["bptree", 0], "bptree/": ["bptree", 0],
    "meta.height": ["bptree/meta.go", 17],
    "shared/bptree-sim.js": ["explanation/shared/bptree-sim.js", 0],
    "shared/bptree-viz.js": ["explanation/shared/bptree-viz.js", 0],
  };

  // <code> の先頭の識別子 (ドット/パス連結可) を取り出し SYMS を引く。
  // 識別子の後が行末か "(" (呼出し引数) または ++/-- のときのみ採用。
  //   "leafFindPos(15)" → leafFindPos    "f.latch.RLock()" → f.latch.RLock
  //   "internalChild(…,ci)" → internalChild   "nextPageID++" → nextPageID
  // 先頭一致しない複合式は、文中の登録シンボルが 1 種類だけの場合に限り
  // それへリンクする ("count < MinLeafPairs" → MinLeafPairs)。
  // 複数シンボル列挙 ("Put / Get / …") や非シンボル ("[30,50]") は除外。
  function symbolOf(text) {
    const s = text.trim();
    const m = s.match(/^([A-Za-z_][\w./-]*?)(\+\+|--)?(\(|\s*$)/);
    if (m) {
      const full = m[1];
      if (SYMS[full]) return SYMS[full];
      const last = full.split(".").pop();
      if (last !== full && SYMS[last]) return SYMS[last];
    }
    const hits = new Map();
    for (const t of s.match(/[A-Za-z_][\w.]*/g) || []) {
      const hit = SYMS[t] || SYMS[t.split(".").pop()];
      if (hit) hits.set(hit.join(":"), hit);
    }
    return hits.size === 1 ? hits.values().next().value : null;
  }

  // root 配下の <code> を走査し、登録シンボルを GitHub リンクで包む。
  function linkSymbols(root) {
    if (!root || !root.querySelectorAll) return;
    for (const code of root.querySelectorAll("code")) {
      if (code.parentElement && code.parentElement.tagName === "A") continue;
      const hit = symbolOf(code.textContent);
      if (!hit) continue;
      // ファイルは blob (#L 行指定可)、ディレクトリは tree ビューへ
      const url = hit[0].includes(".")
        ? ghURL(hit[0], hit[1]) : GH_TREE + hit[0];
      const a = document.createElement("a");
      a.setAttribute("href", url);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
      a.className = "gh";
      code.parentElement.insertBefore(a, code);
      a.appendChild(code);
    }
  }

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // コードパネルの .file ヘッダ (overview.html など viz 非経由のもの) 中の
  // *.go ファイル名を GitHub リンク化。bptree-viz.js が既にリンク化済みの
  // もの (内部に <a> がある) はスキップ。ディレクトリなしの名前は
  // bptree/ 配下とみなす。
  function linkFileHeads(root) {
    if (!root || !root.querySelectorAll) return;
    for (const el of root.querySelectorAll(".file")) {
      if (el.querySelector && el.querySelector("a")) continue;
      const t = el.textContent || "";
      if (!t.includes(".go")) continue;
      el.innerHTML = escHtml(t).replace(/[\w./-]+\.go/g, m => {
        const p = m.includes("/") ? m : "bptree/" + m;
        return `<a class="gh" href="${GH_BLOB}${p}" ` +
          `target="_blank" rel="noopener">${m}</a>`;
      });
    }
  }

  const run = () => {
    linkSymbols(document);
    linkFileHeads(document);
  };
  if (typeof document !== "undefined" && document.readyState === "loading" &&
      document.addEventListener) {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run(); // DOM シム等: querySelectorAll が無ければ内部で no-op
  }

  if (typeof globalThis !== "undefined") {
    globalThis.ghURL = ghURL;
    globalThis.linkSymbols = linkSymbols;
    globalThis.linkFileHeads = linkFileHeads;
    globalThis.GH_SYMS = SYMS;
  }
})();
