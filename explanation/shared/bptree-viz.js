/* bptree-viz.js — DOM/SVG + WAAPI(FLIP) で B+ 木ステップ列を描画する可視化エンジン。
 * グローバル: BptreeViz, mountTopic
 * 依存: なし (素の DOM)。file:// 直開きのため <script src> で読み込む。
 *
 * 要素(DOM)識別:
 *   ノード: "N:<pid>:<gen>"   — PageID フリーリスト再利用に備え世代込み
 *   葉ペア: "P:<key>"         — key は木内一意なのでノード跨ぎ移動を FLIP 追跡
 *   内部 sep: "S:<nodeId>:<key>"
 *   子ポインタ: "C:<nodeId>:<idx>"
 */
"use strict";
(function () {
  const CW = 32, KVW = 56, CSW = 22, NXW = 20;   // セル幅
  const PADX = 6, NODE_GAP = 18, LEVEL_H = 92, TOP = 26, LEFT = 14;

  function nodeWidth(n) {
    if (n.leaf) return PADX * 2 + n.keys.length * KVW + NXW + 3;
    return PADX * 2 + n.children.length * CSW + n.keys.length * CW;
  }

  // 木レイアウト: 葉を左→右に等間隔、内部ノードは子の重心。x = ノード左端。
  function layout(nodes, rootId) {
    const pos = new Map(); let leafX = LEFT;
    const rec = (id, level) => {
      const n = nodes[id]; if (!n) return 0;
      const w = nodeWidth(n);
      const y = TOP + level * LEVEL_H;
      if (n.leaf) {
        pos.set(id, { x: leafX, y, w });
        leafX += w + NODE_GAP; return leafX - NODE_GAP - w / 2;
      }
      const cs = n.children.map(c => rec(c, level + 1));
      const cx = (cs[0] + cs[cs.length - 1]) / 2;
      pos.set(id, { x: Math.round(cx - w / 2), y, w });
      return cx;
    };
    if (rootId) rec(rootId, 0);
    return { pos, width: leafX + LEFT };
  }

  class BptreeViz {
    constructor(canvas) {
      this.canvas = canvas;                       // .bp-canvas 要素
      this.canvas.innerHTML = "";
      this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svg.setAttribute("class", "edges");
      this.canvas.appendChild(this.svg);
      this.nodes = new Map();      // nodeId -> {el, node}
      this.cells = new Map();      // cellId -> {el, nodeId}
      this.lastPos = new Map();    // nodeId -> {x,y,w}
      this.meta = document.createElement("div");
      this.meta.className = "bp-meta";
      this.canvas.appendChild(this.meta);
    }

    // 1ステップ描画 (FLIP アニメ付き)
    // step: {events, marks:{nodeId->"R"|"W"}, statuses:{nodeId->status}, state, caption, code?}
    render(step) {
      const st = step.state;
      const latchMarks = step.marks || {};
      const statuses = step.statuses || {};
      const { pos, width } = layout(st.nodes, st.root);
      this.canvas.style.width = Math.max(width, this.canvas.parentElement.clientWidth || 0) + "px";
      this.canvas.parentElement.scrollLeft = 0;

      // --- FLIP first: 現在位置を記録 ---
      const before = new Map();
      const rect = el => el.getBoundingClientRect();
      for (const [id, c] of this.cells) before.set("c:" + id, rect(c.el));
      for (const [id, n] of this.nodes) before.set("n:" + id, rect(n.el));
      const canvasRect = rect(this.canvas);

      // --- ノード DOM 更新 ---
      const statusCls = { visited: "visited", target: "target", underflow: "underflow" };
      const seenNodes = new Set();
      this.wanted = new Set();                    // 全ノードが要求するセルid
      for (const id of Object.keys(st.nodes)) {
        const n = st.nodes[id]; const p = pos.get(id); if (!p) continue;
        seenNodes.add(id);
        let e = this.nodes.get(id);
        if (!e) {
          const el = document.createElement("div");
          el.className = "bp-node";
          el.dataset.nid = id;
          this.canvas.appendChild(el);
          e = { el, node: n };
          this.nodes.set(id, e);
          el.style.opacity = "0";
          animate(el, [{ opacity: 0, transform: "scale(.7)" },
                       { opacity: 1, transform: "scale(1)" }], 260);
          el.style.opacity = "";
        }
        const el = e.el; e.node = n;
        el.className = "bp-node " + (n.leaf ? "leaf" : "internal") +
          (statusCls[statuses[id]] ? " " + statusCls[statuses[id]] : "");
        el.style.left = p.x + "px"; el.style.top = p.y + "px";
        el.style.width = p.w + "px"; el.style.height = "30px";
        this.lastPos.set(id, p);
        this.syncCells(id, n, el);
        this.syncBadges(id, n, el, latchMarks);
      }
      // 消えたノード: freed 演出 (state.nodes に無いが直前まで存在)
      for (const [id, e] of this.nodes) {
        if (seenNodes.has(id)) continue;
        if (statuses[id] === "freed" && this.lastPos.has(id)) {
          e.el.classList.add("freed");            // 破線・透過で1ステップ残す
          const lch = e.el.querySelectorAll(".latch-badge");
          lch.forEach(b => b.remove());
        } else {
          for (const [cid, c] of [...this.cells])
            if (c.nodeId === id) this.cells.delete(cid);
          e.el.remove(); this.nodes.delete(id);
        }
      }

      // 誰にも要求されなかったセルを削除 (借用手前のドナー側 sync で消さないよう
      // 削除は全ノード同期後に一括で行う → 移動セルの DOM 同一性が保たれる)
      for (const [cid, c] of [...this.cells]) {
        if (!this.wanted.has(cid)) { c.el.remove(); this.cells.delete(cid); }
      }

      // --- FLIP last + invert + play (ノード & セル) ---
      this.flip(before, canvasRect);
      this.flipCells(before, canvasRect);

      // --- エッジ ---
      this.drawEdges(st, pos, seenNodes);
      // --- メタ行 ---
      this.meta.innerHTML =
        `root=<b>${st.root}</b> height=<b>${st.height}</b> ` +
        `freelist=<b>[${st.freelist.join(",")}]</b> nextPID=<b>${st.nextPID}</b>`;
      this.canvas.setAttribute("data-caption", step.caption || "");
      return step.caption;
    }

    syncBadges(id, n, el, latchMarks) {
      let pid = el.querySelector(".pid");
      if (!pid) {
        pid = document.createElement("span"); pid.className = "pid";
        el.insertBefore(pid, el.firstChild);
      }
      pid.textContent = "p" + n.pid + (n.leaf ? " leaf" : " internal");
      let badge = el.querySelector(".latch-badge");
      const lat = latchMarks[id];
      if (!lat) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "latch-badge"; el.appendChild(badge);
      }
      badge.className = "latch-badge " + lat;
      badge.textContent = lat === "W" ? "W排他" : "R共有";
    }

    // セル(葉ペア / sep / 子ptr)の差分同期。移動は render() 側の flipCells で処理。
    // cellId はノードキー id (p<pid>g<gen>) でスコープ — 全ノードで一意にする。
    syncCells(id, n, el) {
      const want = [];   // [{id, cls, text}]
      if (n.leaf) {
        n.keys.forEach((k, i) => want.push(
          { id: "P:" + k, cls: "kv", text: k + ":" + n.vals[i] }));
        want.push({ id: "NX:" + id, cls: "next-slot",
          text: n.next ? "→" + n.next.replace(/g\d+$/, "") : "→∅" });
      } else {
        n.children.forEach((c, i) => {
          want.push({ id: "C:" + id + ":" + i, cls: "child-slot",
            text: c.replace(/g\d+$/, "") });
          if (i < n.keys.length) want.push(
            { id: "S:" + id + ":" + n.keys[i], cls: "", text: n.keys[i] });
        });
      }
      const seen = new Set();
      // appendChild 順 = want 順 (pid/latch-badge は position:absolute なので影響なし)
      for (const w of want) {
        seen.add(w.id); this.wanted.add(w.id);
        let cell = this.cells.get(w.id);
        if (!cell) {
          const d = document.createElement("div");
          cell = { el: d, nodeId: id };
          d.className = "bp-cell " + w.cls;
          d.dataset.cid = w.id;
          this.cells.set(w.id, cell);
          animate(d, [{ opacity: 0, transform: "scale(.4)" },
                      { opacity: 1, transform: "scale(1)" }], 240);
        }
        cell.nodeId = id;
        cell.el.className = "bp-cell " + w.cls;
        if (cell.el.textContent !== String(w.text)) cell.el.textContent = w.text;
        el.appendChild(cell.el);
      }
      void seen;   // wanted は render() 側で一括判定
    }

    flip(before, canvasRect) {
      for (const [id, e] of this.nodes) {
        const b = before.get("n:" + id); if (!b) continue;
        const a = e.el.getBoundingClientRect();
        const dx = b.left - a.left, dy = b.top - a.top;
        if (dx || dy) animate(e.el,
          [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], 300);
      }
    }

    flipCells(before, canvasRect) {
      for (const [id, c] of this.cells) {
        const b = before.get("c:" + id);
        if (!b || b.width === 0) continue;
        const a = c.el.getBoundingClientRect();
        const dx = b.left - a.left, dy = b.top - a.top;
        if (dx || dy) animate(c.el,
          [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], 340);
      }
    }

    drawEdges(st, pos, seen) {
      while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
      const H = 30;
      for (const id of seen) {
        const n = st.nodes[id]; if (!n || n.leaf) continue;
        const p = pos.get(id);
        for (const cid of n.children) {
          const cp = pos.get(cid); if (!cp) continue;
          line(this.svg, p.x + p.w / 2, p.y + H, cp.x + cp.w / 2, cp.y);
        }
      }
      // 葉チェーン (next はノード id 文字列)
      for (const id of seen) {
        const n = st.nodes[id];
        if (n && n.leaf && n.next && seen.has(n.next)) {
          const a = pos.get(id), b = pos.get(n.next);
          if (a && b) {
            const y = a.y + H + 14;
            arrow(this.svg, a.x + a.w / 2, y, b.x + b.w / 2, y);
          }
        }
      }
      // meta -> root
      if (st.root) {
        const rp = pos.get(st.root);
        if (rp) {
          const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
          t.setAttribute("x", rp.x + rp.w / 2); t.setAttribute("y", 12);
          t.setAttribute("fill", "#8fa3b8"); t.setAttribute("font-size", "10");
          t.setAttribute("text-anchor", "middle");
          t.textContent = "meta: root=p" + st.root;
          this.svg.appendChild(t);
        }
      }
    }

    reset() {
      for (const [, e] of this.nodes) e.el.remove();
      this.nodes.clear(); this.cells.clear(); this.lastPos.clear();
    }
  }

  function animate(el, frames, ms) {
    if (el.animate) el.animate(frames, { duration: ms, easing: "ease-in-out" });
  }
  function line(svg, x1, y1, x2, y2) {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", "#4a5d75"); l.setAttribute("stroke-width", "1.5");
    svg.appendChild(l);
  }
  function arrow(svg, x1, y, x2) {
    line(svg, x1, y, x2, y);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    t.setAttribute("points", `${x2},${y} ${x2 - 6},${y - 3} ${x2 - 6},${y + 3}`);
    t.setAttribute("fill", "#3fb97f"); svg.appendChild(t);
  }

  /* トピックステージのマウント: controls/caption/canvas/code 一体 */
  function mountTopic(root, cfg) {
    // cfg: { steps:[{events,marks,caption,state}], code:{file,lines:[{no,text}]}, title }
    const canvasWrap = root.querySelector(".canvas-wrap .bp-canvas") ||
      root.querySelector(".bp-canvas");
    const viz = new BptreeViz(canvasWrap);
    const caption = root.querySelector(".caption");
    const stepno = root.querySelector(".stepno");
    const codeEl = root.querySelector(".codepanel");
    let i = -1, timer = null;

    // コードパネル構築
    if (cfg.code && codeEl) {
      codeEl.innerHTML = `<div class="file">${cfg.code.file}</div>`;
      const pre = document.createElement("pre");
      for (const l of cfg.code.lines) {
        const s = document.createElement("span");
        s.className = "ln"; s.dataset.no = l.no;
        s.innerHTML = `<span class="no">${l.no}</span>` + esc(l.text);
        pre.appendChild(s);
      }
      codeEl.appendChild(pre);
    }

    function show(stepIdx) {
      stepIdx = Math.max(0, Math.min(cfg.steps.length - 1, stepIdx));
      i = stepIdx;
      const st = cfg.steps[i];
      viz.render(st);
      if (caption) caption.textContent = st.caption || "";
      if (stepno) stepno.textContent = `${i + 1} / ${cfg.steps.length}`;
      const hl = st.code ? st.code.hl : [];
      if (codeEl) {
        codeEl.querySelectorAll(".ln").forEach(el => {
          const no = +el.dataset.no;
          el.classList.toggle("hl", hl.includes(no));
        });
        const first = codeEl.querySelector(".ln.hl");
        if (first) first.scrollIntoView({ block: "nearest" });
      }
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function play() {
      if (timer) return stop();
      timer = setInterval(() => {
        if (i >= cfg.steps.length - 1) return stop();
        show(i + 1);
      }, cfg.interval || 900);
    }
    const btnP = root.querySelector(".b-prev"), btnN = root.querySelector(".b-next"),
          btnA = root.querySelector(".b-auto"), btnR = root.querySelector(".b-reset");
    if (btnP) btnP.onclick = () => { stop(); show(i - 1); };
    if (btnN) btnN.onclick = () => { stop(); show(i + 1); };
    if (btnA) btnA.onclick = () => play();
    if (btnR) btnR.onclick = () => { stop(); viz.reset(); show(0); };
    show(0);
    return { show, play, stop, viz, count: cfg.steps.length };
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* sim の steps にコードハイライト情報を付けるヘルパ。
   * plan[i] = {hl:[行番号,...]} → steps[i].code.hl に格納する。 */
  function attachCode(steps, plan) {
    steps.forEach((s, i) => { if (plan[i]) s.code = plan[i]; });
    return steps;
  }

  if (typeof globalThis !== "undefined") {
    globalThis.BptreeViz = BptreeViz;
    globalThis.mountTopic = mountTopic;
    globalThis.attachCode = attachCode;
  }
})();
