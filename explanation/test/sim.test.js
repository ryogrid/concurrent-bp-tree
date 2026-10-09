// sim.test.js — bptree-sim.js の単体テスト (node --test で実行)。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { BptreeSim } = require("../shared/bptree-sim.js");

// ---- helpers ------------------------------------------------------------

// 全ノードの構造不変条件を検査
function checkInvariants(sim) {
  const seen = new Set();
  const visit = (n, isRoot) => {
    assert.ok(!seen.has(n.id()), "cycle detected");
    seen.add(n.id());
    if (!isRoot) {
      const min = n.leaf ? sim.minLeaf : sim.minInternal;
      assert.ok(n.count >= 0, `negative count ${n.pid}`);
      // 残留アンダーフローは合法 (lazy rebalance) なので下限は 1
      assert.ok(n.count >= 1, `non-root node ${n.pid} below residual floor`);
    }
    const max = n.leaf ? sim.maxLeaf : sim.maxInternal;
    assert.ok(n.count <= max, `node ${n.pid} over capacity`);
    // キー昇順
    for (let i = 1; i < n.keys.length; i++)
      assert.ok(n.keys[i] > n.keys[i - 1], `unsorted keys in ${n.pid}`);
    if (!n.leaf) {
      assert.strictEqual(n.children.length, n.count + 1,
        `internal ${n.pid}: children != keys+1`);
      // 分離キー不変条件: max(child[i]) < key[i] <= min(child[i+1])。
      // 葉の最小キー削除では sep は更新されない (stale-low は合法)。
      for (let i = 0; i < n.count; i++) {
        assert.ok(n.keys[i] <= subtreeMin(n.children[i + 1]),
          `sep ${n.keys[i]} above right min in ${n.pid}[${i}]`);
        assert.ok(n.keys[i] > subtreeMax(n.children[i]),
          `sep ${n.keys[i]} not above left max in ${n.pid}[${i}]`);
      }
      n.children.forEach(c => visit(c, false));
    }
  };
  if (sim.root) visit(sim.root, true);
  // 葉チェーン = 全葉の昇順カバー
  const leafKeys = sim.keys();
  for (let i = 1; i < leafKeys.length; i++)
    assert.ok(leafKeys[i] > leafKeys[i - 1], "leaf chain not sorted");
  // 全ノードが木に属する (孤立ノードなし)
  assert.strictEqual(seen.size, sim.pages.size, "orphan pages exist");
}
function subtreeMin(n) { while (!n.leaf) n = n.children[0]; return n.keys[0]; }
function subtreeMax(n) {
  while (!n.leaf) n = n.children[n.children.length - 1];
  return n.keys[n.keys.length - 1];
}

function allEvents(steps) { return steps.flatMap(s => s.events); }
function hasEvent(steps, pred) { return allEvents(steps).some(pred); }

// 操作後にラッチが全解放されていること (リーク検査)
function noLatchLeak(sim, steps) {
  const last = steps[steps.length - 1];
  assert.deepStrictEqual(last.marks, {}, "latch leak: marks remain");
  assert.strictEqual(sim.latches.size, 0, "latch leak in sim.latches");
}

// ---- 基本操作 ----

test("sequential inserts build sorted tree; oracle matches leaf chain", () => {
  const sim = new BptreeSim();
  const oracle = new Map();
  const keys = [];
  for (let i = 1; i <= 40; i++) keys.push(i * 10);
  // シャッフルして挿入
  for (let i = keys.length - 1; i > 0; i--) {
    const j = (i * 7 + 3) % (i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  for (const k of keys) {
    const { steps } = sim.put(k, k * 2);
    oracle.set(k, k * 2);
    noLatchLeak(sim, steps);
    checkInvariants(sim);
  }
  assert.deepStrictEqual(sim.keys(), [...oracle.keys()].sort((a, b) => a - b));
});

test("get hit/miss on built tree", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  assert.strictEqual(sim.get(40).found, true);
  assert.strictEqual(sim.get(45).found, false);
  assert.strictEqual(sim.get(5).found, false);
});

test("delete all keys one by one; tree shrinks to empty leaf root", () => {
  const sim = new BptreeSim();
  const keys = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (const k of keys) sim.put(k, k);
  for (const k of keys) {
    const { steps, removed } = sim.del(k);
    assert.strictEqual(removed, true);
    noLatchLeak(sim, steps);
    checkInvariants(sim);
  }
  assert.deepStrictEqual(sim.keys(), []);
  assert.strictEqual(sim.height, 1, "tree should shrink to leaf root");
});

test("random insert/delete vs Map oracle", () => {
  const sim = new BptreeSim();
  const oracle = new Map();
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) {
    const k = Math.floor(rnd() * 200) * 10;
    if (rnd() < 0.6) {
      sim.put(k, k + 1);
      oracle.set(k, k + 1);
    } else {
      const { removed } = sim.del(k);
      assert.strictEqual(removed, oracle.has(k));
      oracle.delete(k);
    }
    checkInvariants(sim);
  }
  assert.deepStrictEqual(sim.keys(), [...oracle.keys()].sort((a, b) => a - b));
});

// ---- イベント / シナリオ正当性 (scenarios.md のキー列検証) ----

test("baseline tree shape matches scenarios.md", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  assert.strictEqual(sim.height, 2);
  assert.deepStrictEqual(sim.root.keys, [30, 50]);
  assert.deepStrictEqual(sim.keys(), [10, 20, 30, 40, 50, 60, 70]);
});

test("leaf split emits split+copyUp path (node-insert scenario)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70, 75]) sim.put(k, k);
  const { steps } = sim.put(80, 80);
  assert.ok(hasEvent(steps, e => e.t === "split"), "no leaf split");
  assert.ok(hasEvent(steps, e => e.t === "alloc"), "no page alloc");
  assert.ok(hasEvent(steps, e => e.t === "internalInsert"), "no parent insert");
  // 葉分裂の分離キーは copyUp (キーは右葉に残る) であり promoteUp ではない
  assert.ok(hasEvent(steps, e => e.t === "copyUp"), "no copyUp event");
  assert.ok(!hasEvent(steps, e => e.t === "promoteUp"), "unexpected promoteUp");
  checkInvariants(sim);
});

test("internal split + rootGrow (split.html demo B)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95])
    sim.put(k, k);
  assert.strictEqual(sim.height, 2);
  assert.deepStrictEqual(sim.root.keys, [30, 50, 70, 80]); // root 満杯
  const { steps } = sim.put(100, 100);
  assert.ok(hasEvent(steps, e => e.t === "rootGrow"), "no root growth");
  // 内部分裂が発生し、中央キーは「昇格」(子から消えて親へ移動)
  assert.ok(hasEvent(steps, e => e.t === "promoteUp"), "no promoteUp event");
  assert.strictEqual(sim.height, 3);
  assert.deepStrictEqual(sim.root.keys, [70]);
  checkInvariants(sim);
});

test("right borrow (merge.html demo A)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70, 45]) sim.put(k, k);
  const { steps } = sim.del(20);
  assert.ok(hasEvent(steps, e => e.t === "borrow" && e.dir === "right"),
    "expected right borrow");
  assert.deepStrictEqual(sim.root.keys, [40, 50]);
  checkInvariants(sim);
});

test("left borrow via TryLock path (merge.html demo B)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70, 45]) sim.put(k, k);
  sim.del(70);
  const { steps } = sim.del(60);
  assert.ok(hasEvent(steps, e => e.t === "trylock" && e.ok),
    "expected successful trylock");
  assert.ok(hasEvent(steps, e => e.t === "borrow" && e.dir === "left"),
    "expected left borrow");
  assert.deepStrictEqual(sim.root.keys, [30, 45]);
  checkInvariants(sim);
});

test("right merge + freePage (merge.html demo C)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  const { steps } = sim.del(20);
  assert.ok(hasEvent(steps, e => e.t === "merge"), "expected merge");
  assert.ok(hasEvent(steps, e => e.t === "free"), "expected freed page");
  assert.deepStrictEqual(sim.root.keys, [50]);
  checkInvariants(sim);
});

test("left merge via TryLock (merge.html demo D)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  sim.del(70);
  const { steps } = sim.del(60);
  assert.ok(hasEvent(steps, e => e.t === "merge"), "expected merge");
  assert.ok(hasEvent(steps, e => e.t === "free"), "expected freed page");
  assert.deepStrictEqual(sim.root.keys, [30]);
  checkInvariants(sim);
});

test("internal merge + rootShrink (merge.html demo E)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 100])
    sim.put(k, k);
  assert.strictEqual(sim.height, 3);
  const { steps } = sim.del(20);
  assert.ok(hasEvent(steps, e => e.t === "merge" && e.sep === 70),
    "expected internal merge pulling down sep 70");
  assert.ok(hasEvent(steps, e => e.t === "rootShrink"), "expected root shrink");
  assert.strictEqual(sim.height, 2);
  checkInvariants(sim);
});

test("injected trylock-fail restarts op; key still removed (merge.html demo B fail)", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70, 45]) sim.put(k, k);
  sim.del(70);
  const { steps, removed, attempts } = sim.del(60, { trylockFail: true });
  assert.strictEqual(attempts, 2);
  assert.strictEqual(removed, true);
  assert.ok(hasEvent(steps, e => e.t === "trylock" && !e.ok),
    "expected failed trylock");
  assert.ok(steps.some(s => s.tag === "restart"), "expected restart step");
  checkInvariants(sim);
});

test("structure tab3: merge cascade shrinks height-2 tree to leaf root", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50]) sim.put(k, k);
  assert.strictEqual(sim.height, 2);
  sim.del(40);
  const { steps } = sim.del(50);
  assert.ok(hasEvent(steps, e => e.t === "rootShrink"), "expected rootShrink");
  assert.strictEqual(sim.height, 1);
  assert.ok(sim.root.leaf);
  checkInvariants(sim);
});

test("freelist reuse: freed page is reallocated", () => {
  const sim = new BptreeSim();
  for (const k of [10, 20, 30, 40, 50, 60, 70]) sim.put(k, k);
  sim.del(20); // 葉マージ → freePage
  assert.strictEqual(sim.freelist.length, 1);
  const before = sim.nextPID;
  sim.put(80, 80);                       // L3 [50,60,70,80] 満杯化
  const { steps } = sim.put(90, 90);     // 分裂 → allocPage が freelist 再利用
  assert.ok(hasEvent(steps, e => e.t === "alloc" && e.via === "freelist"),
    "expected freelist reuse");
  assert.strictEqual(sim.nextPID, before, "nextPID should not grow on reuse");
  checkInvariants(sim);
});

test("get: 降下中の同時 R ラッチは親子 2 枚が上限 (カップリング)", () => {
  const sim = new BptreeSim();
  // 40件挿入で高さ3以上 (内部ノードが多段) の木
  for (let i = 1; i <= 40; i++) sim.put(i * 10, i);
  assert.ok(sim.height >= 3, `height=${sim.height} should be >=3`);
  const { steps } = sim.get(150);
  let sawCouple = false, sawRelease = false;
  for (const st of steps) {
    const n = Object.keys(st.marks).length;
    assert.ok(n <= 2, `get の ${st.tag} ステップで ${n} 枚ラッチ`);
    if (st.tag === "descend") {
      assert.strictEqual(n, 2, "カップリングの瞬間は親子 2 枚");
      sawCouple = true;
    }
    if (st.tag === "release-parent") {
      assert.strictEqual(n, 1, "親解放後は子のみ保持");
      sawRelease = true;
    }
  }
  assert.ok(sawCouple && sawRelease,
    "descend(双方ラッチ) → release-parent(親解放) の両方を踏むこと");
  checkInvariants(sim);
});

test("del: unsafe 祖先はラッチを保持したまま降下 (3枚保持は正しい動作)", () => {
  const sim = new BptreeSim();
  for (const k of [10,20,30,40,50,60,70,75,80,85,90,95,100])
    sim.put(k, k * 100);
  const { steps } = sim.del(20);  // merge.html デモ E と同じ木
  // 高さ3 → 降下中に root+中間+葉 の 3 枚 W ラッチを同時保持するステップがある
  const deep = steps.filter(s => s.tag === "descend-unsafe" &&
    Object.keys(s.marks).length === 3);
  assert.ok(deep.length > 0, "高さ3の unsafe 降下で 3 枚保持が見えるはず");
  // どのステップも、キャプションがラッチ「解放」を謳うなら保持数は減っている
  // こと。freed ステータスのノードは可視化上バッジが消えるので保持数から除く。
  for (const st of steps) {
    if (/全解放|一括解放|解放 →|を解放/.test(st.caption)) {
      const held = Object.keys(st.marks)
        .filter(id => st.statuses[id] !== "freed");
      assert.ok(held.length <= 1 || /保持/.test(st.caption),
        `${st.tag}: 「解放」と言いつつ ${JSON.stringify(st.marks)} を保持`);
    }
    // freed ノードのラッチは必ず先に解放済み (可視化はバッジを消すので
    // marks に残ると「幽霊ノードがラッチ中」に見える)
    for (const [id, status] of Object.entries(st.statuses)) {
      if (status === "freed") {
        assert.ok(!(id in st.marks), `${st.tag}: freed ${id} がまだラッチ中`);
      }
    }
  }
  checkInvariants(sim);
});
