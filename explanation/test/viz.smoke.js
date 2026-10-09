"use strict";
/* viz.smoke.js — 最小 DOM シム上で bptree-viz.js を全ステップ通し描画する。
 * jsdom 非依存 (file:// 直開き方針と同じく外部依存ゼロ)。 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ---------- 最小 DOM シム ----------
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentElement = null;
    this.style = {}; this.dataset = {}; this._cls = new Set();
    this.attrs = {}; this._text = ""; this._html = "";
    this.clientWidth = 800; this.scrollLeft = 0;
    this.classList = {
      add: (...c) => c.forEach(x => this._cls.add(x)),
      remove: (...c) => c.forEach(x => this._cls.delete(x)),
      toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); },
      contains: c => this._cls.has(c),
    };
  }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() {
    return this.children.length
      ? this.children.map(c => c.textContent).join("") : this._text;
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(v) { this._html = v; if (v === "") this.children = []; }
  get innerHTML() { return this._html; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  appendChild(c) {
    if (c.parentElement) c.parentElement.removeChild(c);
    c.parentElement = this; this.children.push(c); return c;
  }
  insertBefore(c, ref) {
    if (c.parentElement) c.parentElement.removeChild(c);
    c.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    i < 0 ? this.children.push(c) : this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1); c.parentElement = null;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  querySelectorAll(sel) {
    const out = [];
    const isCls = sel.startsWith(".");
    const key = isCls ? sel.slice(1) : sel;
    const match = c => c._cls &&
      (isCls ? c._cls.has(key)
             : c._cls.has(key) ||
               String(c.tagName).toUpperCase() === key.toUpperCase());
    const walk = e => {
      for (const c of e.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    }; walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // 複合セレクタ ".a .b" → 子孫を探索 (シム簡易版: クラスのみ対応)
  _match(sel) {
    if (sel.startsWith(".")) return this._cls.has(sel.slice(1));
    return this.tagName === sel.toUpperCase() || this.tagName === sel;
  }
  getBoundingClientRect() {
    return { left: +this.style.left || 0, top: +this.style.top || 0,
      width: parseFloat(this.style.width) || 40, height: 30 };
  }
  scrollIntoView() {}
}
const byId = new Map();
const documentShim = {
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
  getElementById: id => byId.get(id) || null,
};

// sim + viz をグローバルにロード
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, "../shared/bptree-sim.js"), "utf8"));
globalThis.document = documentShim;
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, "../shared/bptree-viz.js"), "utf8"));

function mkStage() {
  const root = new El("div");
  const wrap = new El("div"); wrap.className = "canvas-wrap";
  const cv = new El("div"); cv.className = "bp-canvas";
  wrap.appendChild(cv); root.appendChild(wrap);
  const mk = (cls, tag) => { const e = new El(tag || "div");
    e.className = cls; root.appendChild(e); return e; };
  mk("caption"); mk("stepno", "span"); mk("codepanel");
  mk("b-prev", "button"); mk("b-next", "button");
  mk("b-auto", "button"); mk("b-reset", "button");
  return { root, cv };
}

const { BptreeSim } = globalThis;

test("viz: 全ステップを例外なく描画 (insert+split)", () => {
  const sim = new BptreeSim();
  const steps = [];
  for (const k of [10, 20, 30, 40, 50, 60, 70, 80, 90])
    steps.push(...sim.put(k, k * 10).steps);
  const { root, cv } = mkStage();
  const m = mountTopic(root, { steps });
  assert.strictEqual(m.viz.canvas, cv);
  for (let i = 0; i < steps.length; i++) m.show(i);
  // 最終状態: 全ノードが DOM に存在
  const last = steps[steps.length - 1].state;
  assert.strictEqual(m.viz.nodes.size, Object.keys(last.nodes).length,
    "描画ノード数が最終状態と不一致");
});

test("viz: delete+merge で freed ゴースト表示と PID 世代分離", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  sim.del(70);
  const { steps } = sim.del(60);   // 左マージで L3 が解放される
  const { root } = mkStage();
  const m = mountTopic(root, { steps });
  let sawFreed = false, sawLatchBadge = false;
  for (let i = 0; i < steps.length; i++) {
    m.show(i);
    if ([...m.viz.nodes.values()].some(e => e.el._cls.has("freed")))
      sawFreed = true;
    if ([...m.viz.nodes.values()].some(e => e.el.querySelector("latch-badge")))
      sawLatchBadge = true;
  }
  assert.ok(sawFreed, "freed ノードのゴースト描画が無い");
  assert.ok(sawLatchBadge, "ラッチバッジが一度も描画されていない");
});

test("viz: 借用でペアセルがノード跨ぎで同一 DOM を維持 (FLIP 追跡)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  sim.put(45, 45); sim.del(70);
  const { steps } = sim.del(60);   // 左借用: 45 が L2→L3 へ移動
  const { root } = mkStage();
  const m = mountTopic(root, { steps });
  let pair45Owner = null;
  for (let i = 0; i < steps.length; i++) {
    m.show(i);
    const c = m.viz.cells.get("P:45");
    if (c) {
      if (!pair45Owner) pair45Owner = c;
      else assert.strictEqual(c, pair45Owner,
        "P:45 の DOM 要素が差し替わった (FLIP 追跡不可)");
    }
  }
  assert.ok(pair45Owner, "P:45 セルが見つからない");
});

test("viz: コードパネルのハイライト反映", () => {
  const sim = new BptreeSim();
  const { steps } = sim.put(10, 10);
  attachCode(steps, steps.map(() => ({ hl: [100, 101] })));
  const { root } = mkStage();
  mountTopic(root, {
    steps,
    code: { file: "tree.go", lines: [{ no: 100, text: "a" }, { no: 101, text: "b" }] },
  });
  const hls = root.querySelectorAll("ln").filter(e => e._cls.has("hl"));
  assert.strictEqual(hls.length, 2);
});

// ---------- GitHub リンク生成 (gh-links.js) ----------
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, "../shared/gh-links.js"), "utf8"));

test("gh-links: <code> シンボルが GitHub 行リンクで包まれる", () => {
  const root = new El("div");
  const p = new El("p"); root.appendChild(p);
  const c1 = new El("code"); c1.textContent = "leafFindPos"; p.appendChild(c1);
  const c2 = new El("code"); c2.textContent = "leafInsertAt(b, pos, k, v)";
  p.appendChild(c2);
  const c3 = new El("code"); c3.textContent = "[30,50]"; p.appendChild(c3);
  const c4 = new El("code");
  c4.textContent = "Put / Get / Delete / RangeScan(start,end)";
  p.appendChild(c4);
  const c5 = new El("code"); c5.textContent = "tree.go"; p.appendChild(c5);
  const c6 = new El("code"); c6.textContent = "meta.rootPageID";
  p.appendChild(c6);
  const c7 = new El("code"); c7.textContent = "height--"; p.appendChild(c7);
  const c8 = new El("code"); c8.textContent = "nextPageID++";
  p.appendChild(c8);
  const c9 = new El("code"); c9.textContent = "count < MinLeafPairs";
  p.appendChild(c9);
  const c10 = new El("code");
  c10.textContent = "allocPageRetry → fetchRetry → latch";
  p.appendChild(c10);
  linkSymbols(root);
  const anchors = p.children.filter(c => c.tagName === "a");
  assert.strictEqual(anchors.length, 7,
    "leafFindPos/leafInsertAt/tree.go/meta.rootPageID/height--/nextPageID++/MinLeafPairs の7つだけリンク化");
  const href = i => anchors[i].attrs.href;
  assert.strictEqual(href(0),
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/node.go#L61");
  assert.strictEqual(href(1),
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/node.go#L77");
  assert.strictEqual(href(2),
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/tree.go");
  assert.strictEqual(href(3),
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/meta.go#L16");
  assert.strictEqual(href(4),   // height-- → meta.height
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/meta.go#L17");
  assert.strictEqual(href(5),   // nextPageID++ → nextPageID
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/meta.go#L19");
  assert.strictEqual(href(6),   // 複合式中の唯一シンボル MinLeafPairs
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/const.go#L33");
  // 非シンボル・複数シンボル列挙・複数シンボル複合式はリンク化されない
  assert.strictEqual(p.children.filter(c => c.tagName === "code" &&
    (!c.parentElement || c.parentElement.tagName !== "a")).length, 3);
});

test("gh-links: .file ヘッダの *.go 名が GitHub リンク化", () => {
  const root = new El("div");
  const f1 = new El("div"); f1._cls.add("file");
  f1.textContent = "bptree/tree.go — put()（要約）";
  root.appendChild(f1);
  const f2 = new El("div"); f2._cls.add("file");
  f2.textContent = "bptree/node.go · freelist.go (抜粋)";
  root.appendChild(f2);
  const f3 = new El("div"); f3._cls.add("file");
  f3.innerHTML = '<a href="x">linked</a>';  // 既リンク済み → スキップ
  const inner = new El("a"); inner.attrs.href = "x"; inner.textContent = "linked";
  f3.appendChild(inner); f3._html = "";
  root.appendChild(f3);
  linkFileHeads(root);
  assert.ok(f1._html.includes(
    'href="https://github.com/ryogrid/concurrent-bp-tree/blob/master/bptree/tree.go"'),
    "bptree/tree.go が blob URL にリンク化される");
  assert.ok(f2._html.includes("blob/master/bptree/node.go") &&
    f2._html.includes("blob/master/bptree/freelist.go"),
    "複数ファイル名が個別にリンク化される");
  assert.strictEqual(f3._html, "", "リンク済み .file は再処理されない");
});

test("viz: コードパネルの行番号とファイル名が GitHub リンク", () => {
  const sim = new BptreeSim();
  const { steps } = sim.put(10, 10);
  const { root } = mkStage();
  mountTopic(root, {
    steps,
    code: { file: "bptree/tree.go + node.go (抜粋)",
      lines: [{ no: 297, text: "func put", file: "tree.go" },
              { no: 0, text: "…" }] },
  });
  const panel = root.querySelectorAll("codepanel")[0];
  assert.ok(panel._html.includes(
    "blob/master/bptree/tree.go"), ".file ヘッダのリンクが無い");
  const ln = panel.querySelectorAll("ln")
    .map(e => e._html).join("\n");
  assert.ok(ln.includes("blob/master/bptree/tree.go#L297"),
    "行番号の #L リンクが無い");
  assert.ok(!ln.includes("#L0"), "セパレータ行にリンクが付いている");
});

// ---------- 全トピックページをシム上で実行 ----------
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, "../shared/topics.js"), "utf8"));

const topicFiles = fs.readdirSync(path.join(__dirname, "../topics"))
  .filter(f => f.endsWith(".html"));

for (const f of topicFiles) {
  test(`topics/${f}: ページスクリプト実行 + 全ステップ描画`, () => {
    const html = fs.readFileSync(path.join(__dirname, "../topics", f), "utf8");
    // id 属性を持つ要素をスタブ生成 (構造は buildDemo が作るので空divで足りる)
    byId.clear();
    for (const m of html.matchAll(/id="([^"]+)"/g))
      byId.set(m[1], new El("div"));
    // インライン <script> (src なし) を抽出して実行
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0, `${f}: inline script が見つからない`);
    for (const s of scripts) new Function(s[1])();
    // 構築された各デモを全ステップ再生
    let demos = 0;
    for (const el of byId.values()) {
      if (!el._mount) continue;
      demos++;
      for (let i = 0; i < el._mount.count; i++) {
        el._mount.show(i);
        // コードパネル: 全ステップで 1 行以上ハイライトされること
        // (対応コードがあるのにハイライトされないステップの防止)
        const hlLines = el.querySelectorAll("ln")
          .filter(e => e._cls.has("hl")).length;
        assert.ok(hlLines > 0,
          `${f} step${i}: コードハイライトが 1 行も無い`);
        // hl の行番号はすべてパネル内に存在すること (写経ミスで
        // 指していない行番号が残らないように)
        const panelNos = new Set(
          el.querySelectorAll("ln").map(e => +e.dataset.no));
        for (const no of (el._mount.steps[i].code || { hl: [] }).hl)
          assert.ok(panelNos.has(no),
            `${f} step${i}: hl 行番号 ${no} がコードパネルに存在しない`);
        const viz = el._mount.viz;
        const st = el._mount.viz.lastStepState;
        if (st) {
          // 全ノードが描画されている (未接続の一時ノードも孤立レーンに出る。
          // freed ゴーストは state に無いので除外して数える)
          const live = [...viz.nodes.keys()]
            .filter(id => st.nodes[id]).length;
          assert.strictEqual(live, Object.keys(st.nodes).length,
            `${f} step${i}: 描画ノード数が state と不一致`);
          // 接続線: 内部辺 + 葉チェーン辺がすべて描画されているか
          // (freed マーク済みノードからの stale 辺は仕様上描画しない)
          const dead = viz.lastStepStatuses
            ? new Set(Object.keys(viz.lastStepStatuses)
                .filter(i => viz.lastStepStatuses[i] === "freed"))
            : new Set();
          let wantLines = 0;
          for (const id in st.nodes) {
            if (dead.has(id)) continue;
            const n = st.nodes[id];
            if (!n.leaf) wantLines += n.children.length;
            else if (n.next && st.nodes[n.next]) wantLines += 1;
          }
          const drawnLines = viz.svg.children
            .filter(c => c.tagName === "line").length;
          assert.strictEqual(drawnLines, wantLines,
            `${f} step${i}: 描画エッジ数不一致 (${drawnLines} != ${wantLines})`);
        }
        // セル所有関係: 各ノードのセル DOM は想定どおりの数だけ存在するか
        // (NX:/C:/S: セルidがノードキーで衝突しないことの検査)
        for (const [nid, e] of el._mount.viz.nodes) {
          if (e.el._cls.has("freed")) continue;   // ゴーストはセル除去済み
          const cells = e.el.children.filter(c =>
            c.dataset && c.dataset.cid);
          const st = el._mount.viz.nodes.get(nid).node;
          const want = st.leaf
            ? st.keys.length + 1            // pairs + next slot
            : st.children.length + st.keys.length;
          assert.strictEqual(cells.length, want,
            `${f} step${i}: ${nid} のセル数不一致 (${cells.length} != ${want})`);
        }
      }
      assert.ok(el._mount.count > 1, `${f}: ステップが初期状態のみ`);
    }
    assert.ok(demos > 0, `${f}: デモが構築されなかった`);
  });
}
