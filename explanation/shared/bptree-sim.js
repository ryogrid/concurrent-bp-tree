// bptree-sim.js — 縮小版 B+木シミュレータ。
// bptree/tree.go / node.go のアルゴリズム構造を DOM 非依存で移植したもの。
// 容量定数は MAX=4/MIN=2 に縮小 (実装の 510/255 に対応)。
// 各公開操作は「ステップ列」を返し、viz 層がアニメーション再生する。
// Node.js でも実行可能 (ブラウザのグローバル + CommonJS 両対応)。
(function (global) {
"use strict";

// bptree/const.go に対応 (実装値 510/255 → 縮小値 4/2)。
const MAX_LEAF = 4, MIN_LEAF = 2;
const MAX_INTERNAL = 4, MIN_INTERNAL = 2;

class SimNode {
  // leaf: keys[] + vals[] (ペア)、内部: keys[] + children[] (SimNode 参照)
  constructor(pid, gen, leaf) {
    this.pid = pid;
    this.gen = gen;           // フリーリスト再利用で PageID が再割当される際に識別
    this.leaf = leaf;
    this.keys = [];
    this.vals = [];           // leaf only
    this.children = [];       // internal only
    this.next = null;         // leaf only (SimNode|null = nextLeafPID)
  }
  get count() { return this.keys.length; }
  id() { return `p${this.pid}g${this.gen}`; }
}

class BptreeSim {
  constructor(opts = {}) {
    this.maxLeaf = opts.maxLeaf ?? MAX_LEAF;
    this.minLeaf = this.maxLeaf >> 1;
    this.maxInternal = opts.maxInternal ?? MAX_INTERNAL;
    this.minInternal = this.maxInternal >> 1;

    this.pages = new Map();   // pid -> SimNode
    this.freelist = [];       // freed pids (stack: freePage push / alloc pop)
    this.nextPID = 1;         // meta.nextPageID (page 0 = meta)
    this.genOf = new Map();   // pid -> generation
    this.root = null;
    this.height = 0;

    this.latches = new Map(); // nodeKey(id) -> "R"|"W"  (操作中のみ)
    this.steps = [];          // {tag,caption,events,marks,state}
    this.pendingEvents = [];  // 現ステップに蓄積中のイベント
    this.statuses = {};       // nodeKey -> "target"|"visited"|"underflow"|"freed"

    // initEmpty() 相当: 空の葉ルート (pid 1, height 1) を最初から持つ。
    this.root = this.newNode(true);
    this.height = 1;
  }

  // ---------- page 管理 (disk.go / freelist.go 相当) ----------
  allocPage() {
    let pid;
    if (this.freelist.length > 0) {
      pid = this.freelist.pop();            // フリーリスト再利用
      this.emit({ t: "alloc", pid, via: "freelist" });
    } else {
      pid = this.nextPID++;                 // ファイル伸長 (暗黙)
      this.emit({ t: "alloc", pid, via: "extend" });
    }
    const gen = (this.genOf.get(pid) || 0) + 1;
    this.genOf.set(pid, gen);
    return { pid, gen };
  }
  newNode(leaf) {
    const { pid, gen } = this.allocPage();
    const n = new SimNode(pid, gen, leaf);
    this.pages.set(pid, n);
    return n;
  }
  freePage(n) {
    this.pages.delete(n.pid);
    this.freelist.push(n.pid);              // freelist push
    this.emit({ t: "free", pid: n.pid });
  }

  // ---------- イベント / ステップ ----------
  emit(ev) { this.pendingEvents.push(ev); }
  latch(n, mode) { this.latches.set(n.id(), mode); this.emit({ t: "latch", node: n.id(), mode }); }
  unlatch(n) { this.latches.delete(n.id()); this.emit({ t: "unlatch", node: n.id() }); }
  unlatchAll() { this.latches.clear(); this.emit({ t: "unlatchAll" }); }

  snapshot() {
    const nodes = {};
    for (const n of this.pages.values()) {
      nodes[n.id()] = {
        pid: n.pid, gen: n.gen, leaf: n.leaf,
        keys: n.keys.slice(), vals: n.vals.slice(),
        children: n.children.map(c => c.id()),
        next: n.next ? n.next.id() : null,
      };
    }
    return {
      root: this.root ? this.root.id() : null,
      height: this.height, nodes,
      freelist: this.freelist.slice(), nextPID: this.nextPID,
    };
  }
  step(tag, caption, statuses) {
    this.steps.push({
      tag, caption,
      events: this.pendingEvents.splice(0),
      marks: Object.fromEntries(this.latches),
      statuses: statuses || {},
      state: this.snapshot(),
    });
    this.statuses = {};
  }

  // ---------- node.go プリミティブ相当 ----------
  leafFindPos(n, target) {          // (pos, found)
    let lo = 0, hi = n.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (n.keys[mid] < target) lo = mid + 1; else hi = mid;
    }
    return [lo, lo < n.count && n.keys[lo] === target];
  }
  leafInsertAt(n, pos, k, v) {
    n.keys.splice(pos, 0, k); n.vals.splice(pos, 0, v);
    this.emit({ t: "leafInsert", node: n.id(), pos, key: k });
  }
  leafSetPair(n, pos, v) {
    n.vals[pos] = v;
    this.emit({ t: "leafOverwrite", node: n.id(), pos });
  }
  leafRemoveAt(n, pos) {
    const k = n.keys[pos];
    n.keys.splice(pos, 1); n.vals.splice(pos, 1);
    this.emit({ t: "leafRemove", node: n.id(), pos, key: k });
  }
  // leafInsertSplit: 満杯葉に挿入。scratch (Max+1) で組み立て
  // 左 minLeaf / 右残り へ分割、返り値 = 右葉の最小キー (コピーアップ)。
  leafInsertSplit(b, right, k, v) {
    const pos = this.leafFindPos(b, k)[0];
    const keys = b.keys.slice(0, pos).concat([k]).concat(b.keys.slice(pos));
    const vals = b.vals.slice(0, pos).concat([v]).concat(b.vals.slice(pos));
    const leftN = this.minLeaf;
    b.keys = keys.slice(0, leftN); b.vals = vals.slice(0, leftN);
    right.keys = keys.slice(leftN); right.vals = vals.slice(leftN);
    this.emit({ t: "split", left: b.id(), right: right.id(), sep: right.keys[0] });
    return right.keys[0];
  }
  leafBorrowFromRight(b, right) {
    b.keys.push(right.keys[0]); b.vals.push(right.vals[0]);
    const moved = right.keys.shift(); right.vals.shift();
    this.emit({ t: "borrow", dir: "right", donor: right.id(), recv: b.id(), key: moved });
    return right.keys[0];
  }
  leafBorrowFromLeft(b, left) {
    const k = left.keys.pop(), v = left.vals.pop();
    b.keys.unshift(k); b.vals.unshift(v);
    this.emit({ t: "borrow", dir: "left", donor: left.id(), recv: b.id(), key: k });
    return b.keys[0];
  }
  leafMergeInto(dst, src) {
    dst.keys.push(...src.keys); dst.vals.push(...src.vals);
    this.emit({ t: "merge", dst: dst.id(), src: src.id() });
  }
  internalFindChildIdx(n, target) {
    let lo = 0, hi = n.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (target < n.keys[mid]) hi = mid; else lo = mid + 1;
    }
    return lo;
  }
  internalInsertKeyAt(n, pos, k, right) {
    n.keys.splice(pos, 0, k); n.children.splice(pos + 1, 0, right);
    this.emit({ t: "internalInsert", node: n.id(), pos, key: k, child: right.id() });
  }
  internalRemoveKeyAt(n, pos) {
    const k = n.keys[pos];
    n.keys.splice(pos, 1); n.children.splice(pos + 1, 1);
    this.emit({ t: "internalRemove", node: n.id(), pos, key: k });
  }
  // internalInsertSplit: 満杯内部ノードに (k,newRight) を挿入。
  // scratch (Max+1 keys / Max+2 children)、中央キーを昇格して返す。
  internalInsertSplit(b, right, pos, k, newRight) {
    const keys = b.keys.slice(0, pos).concat([k]).concat(b.keys.slice(pos));
    const children = b.children.slice(0, pos + 1).concat([newRight]).concat(b.children.slice(pos + 1));
    const mid = this.minInternal;
    b.keys = keys.slice(0, mid); b.children = children.slice(0, mid + 1);
    right.keys = keys.slice(mid + 1); right.children = children.slice(mid + 1);
    this.emit({ t: "split", left: b.id(), right: right.id(), sep: keys[mid] });
    return keys[mid];
  }
  internalMergeInto(dst, src, sep) {
    dst.keys.push(sep, ...src.keys); dst.children.push(...src.children);
    this.emit({ t: "merge", dst: dst.id(), src: src.id(), sep });
  }
  internalBorrowFromRight(b, right, sep) {
    b.keys.push(sep);
    b.children.push(right.children.shift());
    const newSep = right.keys.shift();
    this.emit({ t: "borrow", dir: "right", donor: right.id(), recv: b.id(), key: newSep });
    return newSep;
  }
  internalBorrowFromLeft(b, left, sep) {
    const lastChild = left.children.pop();
    const lastKey = left.keys.pop();
    b.keys.unshift(sep); b.children.unshift(lastChild);
    this.emit({ t: "borrow", dir: "left", donor: left.id(), recv: b.id(), key: lastKey });
    return lastKey;
  }
  safeForInsert(n) { return n.count < (n.leaf ? this.maxLeaf : this.maxInternal); }
  safeForDelete(n) { return n.count > (n.leaf ? this.minLeaf : this.minInternal); }

  // ---------- Get (tree.go get) ----------
  get(key) {
    this.steps = []; this.latches.clear(); this.statuses = {};
    let cur = this.root;
    this.latch(cur, "R");
    this.step("latch-root",
      `rootMu.RLock で rootPageID を保護 → ルート p${cur.pid} を fetch + R ラッチ。ここだけ rootMu が必要。`);
    while (!cur.leaf) {
      const ci = this.internalFindChildIdx(cur, key);
      const child = cur.children[ci];
      this.emit({ t: "descend", from: cur.id(), ci, to: child.id() });
      this.latch(child, "R");
      this.step("descend",
        `key=${key}: internalFindChildIdx → child[${ci}] = p${child.pid} を R ラッチ。` +
        `この瞬間だけ親 p${cur.pid} と子の両方がラッチ中 (カップリングの瞬間)。`,
        { [cur.id()]: "visited", [child.id()]: "target" });
      this.unlatch(cur);
      this.step("release-parent",
        `親 p${cur.pid} を RUnlock + Unpin → 保持は子 p${child.pid} のみ。` +
        `同時に持つ R ラッチは最大「親子 2 枚」。`,
        { [cur.id()]: "visited", [child.id()]: "target" });
      cur = child;
    }
    const [pos, found] = this.leafFindPos(cur, key);
    this.step("leaf-find",
      found
        ? `leafFindPos(${key}) → pos=${pos} で発見。値を返却。`
        : `leafFindPos(${key}) → pos=${pos} (found=false): キー不在を返す。`,
      { [cur.id()]: found ? "target" : "visited" });
    this.unlatch(cur);
    this.step("release", "全ラッチ解放 → Unpin。読みは他の読みと完全に並行可能。");
    return { steps: this.steps, found };
  }

  // ---------- Put (tree.go put) ----------
  put(key, value) {
    this.steps = []; this.latches.clear(); this.statuses = {};
    let cur = this.root;
    this.latch(cur, "W");
    // (実装はここで meta.height >= MaxTreeHeight なら ErrMaxTreeHeight を返す。
    //  デモ規模では到達しないため省略)
    this.step("latch-root",
      `rootMu.Lock でルート差し替えを直列化 → ルート p${cur.pid} を W ラッチ。` +
      (this.safeForInsert(cur)
        ? " ルートは安全 → rootMu はここで早期解放 (ルートの W ラッチは保持したまま降下)。"
        : " ルートは分裂し得る → rootMu も保持。"));
    const held = [];
    while (!cur.leaf) {
      const ci = this.internalFindChildIdx(cur, key);
      const cf = cur.children[ci];
      this.emit({ t: "descend", from: cur.id(), ci, to: cf.id() });
      this.latch(cf, "W");
      if (this.safeForInsert(cf)) {
        // 安全な子 → 祖先を全解放 (クラビングの核心)
        for (const h of held) this.unlatch(h.n);
        held.length = 0;
        this.unlatch(cur);
        this.step("descend-safe",
          `child[${ci}] p${cf.pid} は安全 (count<Max) → 祖先ラッチを一括解放。分裂はここで止まる。`,
          { [cf.id()]: "target" });
      } else {
        if (this.safeForInsert(cur)) {
          for (const h of held) this.unlatch(h.n);
          held.length = 0;
        }
        held.push({ n: cur, ci });
        this.step("descend-unsafe",
          `child[${ci}] p${cf.pid} は満杯 → 分裂が伝播し得るので親 p${cur.pid} を保持` +
          (held.length > 1
            ? ` (held の祖先 ${held.length - 1} 枚も保持したまま降下)。`
            : ` (held に積む)。`),
          { [cf.id()]: "target" });
      }
      cur = cf;
    }
    const [pos, found] = this.leafFindPos(cur, key);
    if (found) {
      this.leafSetPair(cur, pos, value);
      this.step("overwrite", `key=${key} は存在 → leafSetPair で値を上書き (upsert)。`, { [cur.id()]: "target" });
      this.finishOp(held, cur);
      return { steps: this.steps };
    }
    if (cur.count < this.maxLeaf) {
      this.leafInsertAt(cur, pos, key, value);
      this.step("insert", `葉に空きあり → leafInsertAt(pos=${pos}) で右シフト挿入 → [${cur.keys.join(",")}]。`, { [cur.id()]: "target" });
      this.finishOp(held, cur);
      return { steps: this.steps };
    }
    // --- 葉分裂 ---
    const right = this.newNode(true);
    this.latch(right, "W");
    let sep = this.leafInsertSplit(cur, right, key, value);
    this.step("leaf-split",
      `葉が満杯 → scratch に ${this.maxLeaf + 1} エントリを組み立て 左${this.minLeaf}/右${this.maxLeaf + 1 - this.minLeaf} 分割。` +
      `新葉 p${right.pid} を割当 (allocPage)。分離キー ${sep} = 右葉の最小キーは右葉に残る (コピーアップ)。`,
      { [cur.id()]: "target", [right.id()]: "target" });
    right.next = cur.next; cur.next = right;
    this.step("leaf-link",
      `水平リンク配線: p${right.pid}.next = 旧 next、p${cur.pid}.next = p${right.pid}。RangeScan が新葉を見逃さない。`,
      { [cur.id()]: "target", [right.id()]: "target" });

    // --- 分離キーの上向き伝播 ---
    let leftNode = cur, rightNode = right;
    let pending = true, fromLeafSplit = true;
    while (pending && held.length > 0) {
      const { n: parent, ci } = held.pop();
      if (parent.count < this.maxInternal) {
        this.internalInsertKeyAt(parent, ci, sep, rightNode);
        // 葉分裂由来の分離キーは「コピー」、内部分裂由来は「昇格(移動)」
        this.emit({ t: fromLeafSplit ? "copyUp" : "promoteUp",
          node: parent.id(), pos: ci, key: sep, child: rightNode.id() });
        this.step("propagate",
          `親 p${parent.pid} に空き → internalInsertKeyAt(pos=${ci}, sep=${sep}, child=p${rightNode.pid})。親に新しい分岐が足された。`,
          { [parent.id()]: "target" });
        this.unlatch(parent);
        pending = false;
      } else {
        const r2 = this.newNode(false);
        this.latch(r2, "W");
        const promoted = this.internalInsertSplit(parent, r2, ci, sep, rightNode);
        this.emit({ t: "promoteUp", from: parent.id(), key: promoted });
        this.unlatch(parent);
        this.unlatch(rightNode);
        this.step("internal-split",
          `親も満杯 → internalInsertSplit: ${this.maxInternal + 1} keys を 左${this.minInternal}/昇格/右${this.minInternal} 分割。` +
          `中央キー ${promoted} は子から消えて親へ「移動」(昇格)。新内部 p${r2.pid}。`,
          { [parent.id()]: "target", [r2.id()]: "target" });
        leftNode = parent; rightNode = r2; sep = promoted; // r2 は次レベルの右側
        fromLeafSplit = false;
      }
    }
    if (pending) {
      // ルートまで伝播 → 新ルートで高さ+1 (internalInitRoot)
      const nr = this.newNode(false);
      this.latch(nr, "W");
      nr.keys = [sep]; nr.children = [leftNode, rightNode];
      this.root = nr; this.height++;
      this.emit({ t: "rootGrow", newRoot: nr.id(), sep });
      this.step("root-grow",
        `分裂がルートまで伝播 → internalInitRoot で新ルート p${nr.pid} (key=${sep}, 2子)。meta.rootPageID 更新, height=${this.height}。`,
        { [nr.id()]: "target" });
      this.unlatch(nr);
    }
    this.unlatch(cur); this.unlatch(rightNode);
    for (const h of held) this.unlatch(h.n);
    this.step("release", "全ラッチ解放 + writeMeta。put 完了。");
    return { steps: this.steps };
  }
  finishOp(held, cur) {
    this.unlatch(cur);
    for (const h of held) this.unlatch(h.n);
    this.step("release", "全ラッチ解放 + writeMeta。put 完了。");
  }

  // ---------- Delete (tree.go delete) ----------
  // inject: {trylockFail: true} で最初の左兄弟 TryLock を 1 回だけ失敗させる
  // (並行説明用フック。実装ではタイミング依存)。
  del(key, inject) {
    this.steps = []; this.latches.clear(); this.statuses = {};
    let removed = false;
    let attempts = 0;
    let injectLeft = inject && inject.trylockFail;
    for (;;) {
      attempts++;
      const r = this.deleteAttempt(key, injectLeft && attempts === 1);
      removed = removed || r.removed;
      if (!r.restart) break;
      injectLeft = false; // 注入は 1 回だけ
      this.step("restart",
        `TryLock 失敗 → 保持中の全ラッチ・全 pin を解放して操作を最初からやり直す (errRestart → retryOp)。` +
        (r.removed ? " キーは試行1で削除済み —— 再降下では found=false だが、残ったアンダーフローのリバランスは続行する。" : ""));
    }
    this.step("release", "全ラッチ解放 + writeMeta。delete 完了。");
    return { steps: this.steps, removed, attempts };
  }
  deleteAttempt(key, failTrylock) {
    let cur = this.root;
    this.latch(cur, "W");
    this.step("latch-root",
      `rootMu.Lock → ルート p${cur.pid} を W ラッチ。` +
      (this.safeForDelete(cur)
        ? " 安全 → rootMu はここで早期解放 (ルートの W ラッチは保持したまま降下)。"
        : " アンダーフローし得る → rootMu も保持。"));
    const held = [];
    while (!cur.leaf) {
      const ci = this.internalFindChildIdx(cur, key);
      const cf = cur.children[ci];
      this.emit({ t: "descend", from: cur.id(), ci, to: cf.id() });
      this.latch(cf, "W");
      if (this.safeForDelete(cf)) {
        for (const h of held) this.unlatch(h.n);
        held.length = 0;
        this.unlatch(cur);
        this.step("descend-safe",
          `child[${ci}] p${cf.pid} は安全 (count>Min) → 祖先ラッチを一括解放。`,
          { [cf.id()]: "target" });
      } else {
        if (this.safeForDelete(cur)) {
          for (const h of held) this.unlatch(h.n);
          held.length = 0;
        }
        held.push({ n: cur, ci });
        this.step("descend-unsafe",
          `child[${ci}] p${cf.pid} は Min 以下 → アンダーフローが伝播し得るので親 p${cur.pid} を保持` +
          (held.length > 1
            ? ` (held の祖先 ${held.length - 1} 枚も保持したまま降下)。`
            : ` (held に積む)。`),
          { [cf.id()]: "target" });
      }
      cur = cf;
    }
    const [pos, found] = this.leafFindPos(cur, key);
    if (found) {
      this.leafRemoveAt(cur, pos);
      this.step("leaf-remove", `leafRemoveAt(pos=${pos}) で削除 → [${cur.keys.join(",")}]。`, { [cur.id()]: "target" });
    } else {
      this.step("leaf-remove", `key=${key} は不在 (found=false)。葉は変更なし。`, { [cur.id()]: "visited" });
    }
    if (cur.count >= this.minLeaf) {
      for (const h of held) this.unlatch(h.n);
      this.unlatch(cur);
      return { removed: found, restart: false };
    }
    // --- アンダーフロー伝播 (Go の for cur != nil ループと同構造) ---
    this.step("underflow", `葉 p${cur.pid} が count=${cur.count} < Min=${this.minLeaf} → 兄弟と調整へ。`, { [cur.id()]: "underflow" });
    while (cur) {
      const leaf = cur.leaf;
      const min = leaf ? this.minLeaf : this.minInternal;
      if (held.length === 0) {
        // cur はルート: 内部ルートが 0 キー 1 子なら縮小、葉ルートは空のまま許容
        if (!leaf && cur.count === 0) {
          const newRoot = cur.children[0];
          const old = cur;
          this.root = newRoot; this.height--;
          this.emit({ t: "rootShrink", old: old.id(), newRoot: newRoot.id() });
          // Go: meta 更新 → release(旧root) → freePage (tree.go:586-590)
          this.unlatch(old);
          this.step("root-shrink",
            `ルートが 0 キー 1 子の内部ノード → meta.root = 子 p${newRoot.pid}, height=${this.height}。旧ルートは解放→フリーリストへ。`,
            { [newRoot.id()]: "target", [old.id()]: "freed" });
          this.freePage(old);
          cur = null;
        } else {
          this.unlatch(cur);
          cur = null;
        }
        break;
      }
      if (cur.count >= min) { this.unlatch(cur); cur = null; break; }
      const { n: parent, ci } = held.pop();
      const pn = parent.count;
      if (pn === 0) {
        // 退化した単一子の親: 兄弟なし → 親自身を上で処理 (Go の pn==0 ガード)
        this.unlatch(cur);
        this.step("climb", "親は退化 (子1つ) → 兄弟処理はできず、親を引き続き上で修復。", { [parent.id()]: "underflow" });
        cur = parent;
        continue;
      }
      if (ci < pn) {
        // 右兄弟 (左→右順で WLatch 可)
        const sib = parent.children[ci + 1];
        this.latch(sib, "W");
        if (sib.count > min) {
          if (leaf) {
            const newSep = this.leafBorrowFromRight(cur, sib);
            parent.keys[ci] = newSep;
          } else {
            parent.keys[ci] = this.internalBorrowFromRight(cur, sib, parent.keys[ci]);
          }
          this.step("borrow-right",
            `右兄弟 p${sib.pid} に余裕 (>Min) → 借用。${leaf ? "最小要素を移し、" : "分離キー引き下ろし+子移動、"}親の分離キーを更新 → [${parent.keys.join(",")}]。`,
            { [cur.id()]: "target", [sib.id()]: "target" });
          this.unlatch(sib); this.unlatch(cur); this.unlatch(parent);
          cur = null;
          break;
        }
        // 右を自分に吸収
        if (leaf) {
          this.leafMergeInto(cur, sib);
          cur.next = sib.next;
        } else {
          this.internalMergeInto(cur, sib, parent.keys[ci]);
        }
        this.internalRemoveKeyAt(parent, ci);
        // Go: マージ完了直後に sib/cur を解放 → freePage へ (tree.go:659-665)
        this.unlatch(sib); this.unlatch(cur);
        this.step("merge-right",
          `右兄弟も Min → マージ: p${sib.pid} を p${cur.pid} に吸収${leaf ? "、nextLeafPID 引継ぎ" : " (分離キーを引き下ろす)"}。` +
          `親から (key,child) を削除 → [${parent.keys.join(",")}]。p${sib.pid} は解放→freePage。`,
          { [cur.id()]: "target", [sib.id()]: "freed", [parent.id()]: "target" });
        this.freePage(sib);
        cur = parent;
        continue;
      }
      // ci == pn: 右端 → 左兄弟 (ロック順序違反 → TryLock + 再試行)
      const sib = parent.children[ci - 1];
      this.emit({ t: "trylock", node: sib.id(), ok: !failTrylock });
      if (failTrylock) {
        // 失敗: 保持中の全ラッチを解放して操作ごと再試行 (errRestart)
        this.unlatchAll();
        this.step("trylock-fail",
          `左兄弟 p${sib.pid} の TryLock が失敗 (スキャン等が保持中) → errRestart。デッドロックを避けるため全解放して再試行。`);
        return { removed: found, restart: true };
      }
      this.latch(sib, "W");
      if (sib.count > min) {
        if (leaf) {
          const newSep = this.leafBorrowFromLeft(cur, sib);
          parent.keys[ci - 1] = newSep;
        } else {
          parent.keys[ci - 1] = this.internalBorrowFromLeft(cur, sib, parent.keys[ci - 1]);
        }
        this.step("borrow-left",
          `TryLock 成功 → 左兄弟 p${sib.pid} から借用 (最大要素を先頭へ)。親 sep[${ci - 1}] を更新 → [${parent.keys.join(",")}]。`,
          { [cur.id()]: "target", [sib.id()]: "target" });
        this.unlatch(sib); this.unlatch(cur); this.unlatch(parent);
        cur = null;
        break;
      }
      // 自分を左兄弟に吸収
      if (leaf) {
        this.leafMergeInto(sib, cur);
        sib.next = cur.next;
      } else {
        this.internalMergeInto(sib, cur, parent.keys[ci - 1]);
      }
      this.internalRemoveKeyAt(parent, ci - 1);
      // Go: マージ完了直後に sib/cur を解放 → freePage へ (tree.go:714-720)
      this.unlatch(sib); this.unlatch(cur);
      this.step("merge-left",
        `左兄弟に自分を吸収: p${cur.pid} → p${sib.pid}${leaf ? "、nextLeafPID 引継ぎ" : " (分離キー引き下ろし)"}。` +
        `親から削除 → [${parent.keys.join(",")}]。p${cur.pid} は解放→freePage。`,
        { [sib.id()]: "target", [cur.id()]: "freed", [parent.id()]: "target" });
      this.freePage(cur);
      cur = parent;
    }
    for (const h of held) this.unlatch(h.n);
    return { removed: found, restart: false };
  }

  // ---------- 検証用: 全キー列 ----------
  keys() {
    const out = [];
    let n = this.root;
    if (!n) return out;
    while (n && !n.leaf) n = n.children[0];
    while (n) { out.push(...n.keys); n = n.next; }
    return out;
  }
}

// ブラウザ (script タグ) と Node (require) 両対応
if (typeof module !== "undefined" && module.exports) module.exports = { BptreeSim, MAX_LEAF, MIN_LEAF, MAX_INTERNAL, MIN_INTERNAL };
else global.BptreeSim = BptreeSim;
})(typeof window !== "undefined" ? window : globalThis);
