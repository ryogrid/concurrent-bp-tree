/* Deterministic interleavings on a real miniature B+ tree.
 * Each transition checks compatibility and parent/leaf handoff before recording.
 * This is a teaching scheduler, not an OS scheduler or a Go runtime. */
(function (global) {
  "use strict";
  class LatchTrace {
    constructor(threads, full = false) {
      this.sim = new BptreeSim();
      for (let k = 10; k <= (full ? 140 : 130); k += 10) this.sim.put(k, k * 100);
      this.threads = threads;
      this.holders = {};
      this.waiting = {};
      this.notes = Object.fromEntries(Object.keys(threads).map(t => [t, "開始前"]));
      this.frames = [];
      this.root = this.sim.root.id();
      this.left = this.sim.root.children[0].id();
      this.right = this.sim.root.children[1].id();
      this.leaves = [...this.sim.pages.values()].filter(n => n.leaf).map(n => n.id());
      this.record("初期状態。最大4・最小2の高さ3の木。ラッチはまだ取得していません。");
    }
    has(t, id, mode) {
      return (this.holders[id] || []).some(([owner, m]) => owner === t && (!mode || mode === m));
    }
    record(caption, event = {}) {
      const marks = {}, owners = {};
      for (const [id, entries] of Object.entries(this.holders)) {
        if (id === "rootMu" || !entries.length) continue;
        marks[id] = entries[0][1];
        owners[id] = entries;
      }
      this.frames.push(JSON.parse(JSON.stringify({
        tag: "latch-trace", caption, state: this.sim.snapshot(), marks, owners,
        statuses: event.id && event.id !== "rootMu" ? { [event.id]: "target" } : {},
        rootLock: (this.holders.rootMu || []).map(([t,m]) => t + ":" + m).join(" ") || null,
        holders: this.holders, waiting: this.waiting, notes: this.notes, event,
      })));
    }
    take(t, id, mode, guard, caption, attempt = false) {
      if (guard && !this.has(t, guard)) throw new Error("Missing handoff guard: " + guard);
      if (this.has(t, id)) throw new Error("Duplicate latch");
      const blocked = (this.holders[id] || []).some(([owner, m]) => owner !== t && (mode === "W" || m === "W"));
      if (blocked) {
        if (!attempt) this.waiting[t] = { id, mode, guard };
        this.notes[t] = attempt ? "TryLock失敗（待機しない）" : id + " の " + mode + " を待機";
      } else {
        (this.holders[id] ||= []).push([t, mode]);
        delete this.waiting[t];
        this.notes[t] = id + " の " + mode + " を取得";
      }
      this.record(caption, { type: attempt ? "try" : "take", t, id, mode, guard, ok: !blocked });
      return !blocked;
    }
    release(t, id, caption) {
      if (!this.has(t, id)) throw new Error("Unlock without ownership");
      this.holders[id] = this.holders[id].filter(([owner]) => owner !== t);
      if (!this.holders[id].length) delete this.holders[id];
      this.notes[t] = id + " を解放";
      this.record(caption, { type: "release", t, id });
    }
    enter(t, write = false, deletion = false) {
      this.take(t, "rootMu", write ? "W" : "R", null, t + "：rootMuを取得して現在のルートを特定。");
      const ok = this.take(t, this.root, write ? "W" : "R", "rootMu", t + "：rootMuを保持したままルートページを取得。");
      if (ok && !deletion) this.release(t, "rootMu", t + "：ルートページを取得済み。読み取り、または挿入に安全なルートなのでrootMuを解放。");
    }
    descend(t, parent, child, mode, safe = true) {
      this.take(t, child, mode, parent, t + "：親を保持したまま子を" + mode + "ラッチ。親子の両方を持つ瞬間。");
      if (safe) this.release(t, parent, t + "：子を取得したので親を解放。書き込みの場合は、この子が安全なことを確認済み。");
      else this.record(t + "：子は安全でないため、構造変更に必要な親を保持して進む。", { type: "retain", t, id: parent });
    }
    change(t, ids, caption, fn) {
      for (const id of ids) if (!this.has(t, id, "W")) throw new Error("Mutation without W");
      fn();
      this.record(caption, { type: "change", t, ids });
    }
    done(t) {
      for (const id of Object.keys(this.holders)) if (this.has(t, id)) this.release(t, id, t + "：処理を終え、保持していたラッチを解放。");
      this.notes[t] = "完了";
      this.record(t + "：完了。");
    }
  }

  function makeScenarios() {
    const scenarios = {};
    let q = new LatchTrace({ T1: "Get(20)", T2: "Get(120)" });
    q.enter("T1"); q.enter("T2");
    q.descend("T1", q.root, q.left, "R");
    q.descend("T2", q.root, q.right, "R");
    q.descend("T1", q.left, q.leaves[0], "R");
    q.descend("T2", q.right, q.leaves[5], "R");
    q.record("両者が別の葉をR保持して検索中。同じページのR共有も、別ページでの並行処理も可能。");
    q.done("T1"); q.done("T2");
    scenarios.sharedReads = q;

    q = new LatchTrace({ T1: "Get(40)", T2: "Put(40,9999)" });
    q.enter("T1"); q.descend("T1", q.root, q.left, "R");
    q.descend("T1", q.left, q.leaves[1], "R");
    q.enter("T2", true); q.descend("T2", q.root, q.left, "W");
    q.take("T2", q.leaves[1], "W", q.left, "T2は葉のWを待つ。まだ取得できていないので、親p3のWも保持したまま。");
    q.done("T1");
    q.take("T2", q.leaves[1], "W", q.left, "T1のR解放後、T2が葉のWを取得できる。");
    q.release("T2", q.left, "子のWを取得し安全を確認できたので、ここで初めて親を解放。");
    q.change("T2", [q.leaves[1]], "T2だけが葉を書き換える。40の値が4000から9999になる。", () => {
      const n = q.sim.pages.get(2); n.vals[n.keys.indexOf(40)] = 9999;
    });
    q.done("T2"); scenarios.readWrite = q;

    q = new LatchTrace({ T1: "Put(15)", T2: "Put(125)" });
    q.enter("T1", true); q.enter("T2", true);
    q.descend("T1", q.root, q.left, "W");
    q.take("T2", q.root, "W", "rootMu", "T1がルートを解放したので、T2がルートのWを取得。");
    q.release("T2", "rootMu", "挿入に安全なルートの取得後、T2もrootMuを解放。");
    q.descend("T1", q.left, q.leaves[0], "W");
    q.descend("T2", q.root, q.right, "W");
    q.descend("T2", q.right, q.leaves[5], "W");
    q.record("T1とT2は異なる葉のWを同時に保持。必要のなくなった祖先はどちらも解放済み。");
    q.change("T1", [q.leaves[0]], "T1が左の葉へ15を挿入。", () => q.sim.leafInsertAt(q.sim.pages.get(1), 1, 15, 1500));
    q.change("T2", [q.leaves[5]], "T2が右の葉へ125を挿入。どちらも4件以内なので分裂しない。", () => q.sim.leafInsertAt(q.sim.pages.get(7), 2, 125, 12500));
    q.done("T1"); q.done("T2"); scenarios.disjointWrites = q;

    q = new LatchTrace({ T1: "RangeScan(30,60)", T2: "Delete(60)" });
    q.enter("T1"); q.descend("T1", q.root, q.left, "R");
    q.descend("T1", q.left, q.leaves[1], "R");
    q.enter("T2", true, true);
    q.descend("T2", q.root, q.left, "W", false);
    q.descend("T2", q.left, q.leaves[2], "W", false);
    q.change("T2", [q.leaves[2]], "T2が60を削除。葉p4は[50]となり下限2を割る。p4は親p3の右端なので左兄弟p2が必要。", () => q.sim.leafRemoveAt(q.sim.pages.get(4), 1));
    q.take("T1", q.leaves[2], "R", q.leaves[1], "T1は左葉p2のRを持ったまま次のp4を待つ。ここでT2がp2を待つと循環してしまう。");
    q.take("T2", q.leaves[1], "W", q.left, "T2は左兄弟p2をTryLock。T1のRと競合するため失敗するが、待機キューには入らない。", true);
    q.change("T2", [q.leaves[2]], "T2はまだp4をW保持しているうちに、削除した60と値6000を元に戻す。", () => q.sim.leafInsertAt(q.sim.pages.get(4), 1, 60, 6000));
    for (const id of [q.leaves[2], q.left, q.root, "rootMu"]) q.release("T2", id, "T2：再試行のため保持ラッチを解放。木は削除前の状態に戻っている。");
    q.take("T1", q.leaves[2], "R", q.leaves[1], "T2のW解放によりT1が右葉のRを取得。左と右を同時に保持して受け渡す。");
    q.release("T1", q.leaves[1], "右葉を確保したので左葉を解放。T1が進めるため待機サイクルはない。");
    q.done("T1");
    q.notes.T2 = "ルートから再試行";
    q.record("T2の再試行開始。以降の削除・借用・マージは「6. 借用・マージ」で追う。今回の試行は変更を残さず終了した。");
    scenarios.scanDelete = q;

    q = new LatchTrace({ T1: "Put(150)", T2: "Get(120)" }, true);
    q.enter("T1", true); q.descend("T1", q.root, q.right, "W");
    q.descend("T1", q.right, q.leaves[5], "W", false);
    q.enter("T2");
    q.take("T2", q.right, "R", q.root, "T2は右内部ノードのRを待つ。T1は満杯の葉を分裂させるため、この親のWを保持している。");
    q.change("T1", [q.right, q.leaves[5]], "T1が葉を分割し、親へ分離キー130と新しい子を登録する。新ページの割当・配線・解放はこの1場面にまとめている。", () => q.sim.put(150, 15000));
    q.release("T1", q.right, "新しい分岐の登録が終わり、親のWを解放。");
    q.take("T2", q.right, "R", q.root, "T2は更新後の親を取得。130未満なので120のある左側の葉へ進む。");
    q.release("T2", q.root, "T2は子のRを確保してからルートを解放。");
    q.take("T2", q.leaves[5], "R", q.right, "T2は目的の葉でT1のW解放を待つ。");
    q.done("T1");
    q.take("T2", q.leaves[5], "R", q.right, "T1が葉のWを解放したので、T2が葉のRを取得。");
    q.release("T2", q.right, "T2も子を取得してから親を解放。120は移動後も正しい経路で見つかる。");
    q.done("T2"); scenarios.unsafeSplit = q;
    return scenarios;
  }

  function mk(tag, cls, text, parent) {
    const el = document.createElement(tag);
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function mountLatchDemo(root, name) {
    const trace = makeScenarios()[name];
    root.classList.add("latch-stage");
    const controls = mk("div", "latch-controls", undefined, root);
    const prev = mk("button", "l-prev", "◀ 戻る", controls);
    const next = mk("button", "l-next", "次へ ▶", controls);
    const reset = mk("button", "l-reset", "最初から", controls);
    const stepno = mk("span", "l-stepno", "", controls);
    const caption = mk("div", "latch-caption", "", root);
    caption.setAttribute("aria-live", "polite");
    const lanes = mk("div", "thread-lanes", undefined, root);
    const laneEls = {};
    for (const [t, op] of Object.entries(trace.threads)) {
      const lane = mk("div", "thread-lane " + t.toLowerCase(), undefined, lanes);
      mk("strong", "thread-name", t + " · " + op, lane);
      laneEls[t] = mk("span", "thread-state", "", lane);
    }
    const wrap = mk("div", "canvas-wrap", undefined, root);
    const viz = new BptreeViz(mk("div", "bp-canvas", undefined, wrap));
    let index = 0;
    function show(i) {
      index = Math.max(0, Math.min(trace.frames.length - 1, i));
      const step = trace.frames[index];
      viz.render(step);
      for (const [id, e] of viz.nodes) {
        e.el.querySelectorAll(".wait-badge").forEach(b => b.remove());
        for (const [t, wait] of Object.entries(step.waiting)) {
          if (wait.id === id) mk("span", "wait-badge", t + ":" + wait.mode + " 待機", e.el);
        }
      }
      for (const [t, lane] of Object.entries(laneEls)) {
        const owned = Object.entries(step.holders).filter(([, hs]) => hs.some(([owner]) => owner === t))
          .map(([id, hs]) => id.replace(/g\d+$/, "") + ":" + hs.find(([owner]) => owner === t)[1]);
        lane.textContent = step.notes[t] + " ／ 保持 " + (owned.join(", ") || "なし");
      }
      caption.textContent = step.caption;
      stepno.textContent = (index + 1) + " / " + trace.frames.length;
      prev.disabled = index === 0;
      next.disabled = index === trace.frames.length - 1;
    }
    prev.onclick = () => show(index - 1);
    next.onclick = () => show(index + 1);
    reset.onclick = () => show(0);
    show(0);
    return root._latchMount = { show, count: trace.frames.length, frames: trace.frames, viz };
  }
  global.makeLatchScenarios = makeScenarios;
  global.mountLatchDemo = mountLatchDemo;
})(globalThis);
