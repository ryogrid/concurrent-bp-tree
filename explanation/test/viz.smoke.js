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
    const out = []; const cls = sel.replace(".", "");
    const walk = e => {
      for (const c of e.children) {
        if (c._cls && c._cls.has(cls)) out.push(c);
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
