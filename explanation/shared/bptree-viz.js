/* bptree-viz.js — DOM/SVG で B+ 木のステップ列を描画する。
 * グローバル: BptreeViz, mountTopic
 * 依存: なし (素の DOM)。file:// 直開きのため <script src> で読み込む。
 *
 * 要素(DOM)識別:
 *   ノード: "N:<pid>:<gen>"   — PageID フリーリスト再利用に備え世代込み
 *   葉ペア: "P:<key>"         — key は木内一意なのでノード跨ぎ移動でも同じセルを維持
 *   内部 sep: "S:<nodeId>:<key>"
 *   子ポインタ: "C:<nodeId>:<idx>"
 */
"use strict";
(function () {
  const CW = 32, KVW = 64, CSW = 34, NXW = 42;   // セル幅
  const PADX = 6, NODE_GAP = 18, LEVEL_H = 92, TOP = 26, LEFT = 14;

  function nodeWidth(n) {
    const cells = n.leaf ? n.keys.length + 1 : n.children.length + n.keys.length;
    return Math.max(144, PADX * 2 + 4 + Math.max(0, cells - 1) * 3 + (n.leaf
      ? n.keys.length * KVW + NXW
      : n.children.length * CSW + n.keys.length * CW));
  }

  // 木レイアウト: 葉を左→右に等間隔、内部ノードは子の重心。x = ノード左端。
  // ルートにまだ接続されていない一時ノード群 (分裂直後・未配線の新部分木や
  // freePage 直前のマージ犠牲ノード) は木の下の「孤立レーン」に
  // ミニ木として配置し破線枠で示す — 配置しないとそのノードも接続線も
  // 描画できず、分裂/マージの途中状態が見えなくなる。
  function layout(nodes, rootId) {
    const pos = new Map(); let leafX = LEFT; let maxLevel = 0;
    const rec = (id, level) => {
      const n = nodes[id]; if (!n) return 0;
      if (pos.has(id)) { const p = pos.get(id); return p.x + p.w / 2; }
      const w = nodeWidth(n);
      const y = TOP + level * LEVEL_H;
      maxLevel = Math.max(maxLevel, level);
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
    // Place detached subtree roots first; allocating leaves before their
    // parent must not put both at the same depth. Use a separate lower row.
    const detached = new Set();
    const orphanBase = maxLevel + 1;
    const mainWidth = leafX;
    leafX = LEFT;
    const orphanIds = Object.keys(nodes).filter(id => !pos.has(id));
    const orphanChildren = new Set(orphanIds.flatMap(id => nodes[id].children));
    const roots = orphanIds.filter(id => !orphanChildren.has(id));
    for (const id of roots) {
      const before = new Set(pos.keys());
      rec(id, orphanBase);
      for (const k of pos.keys()) if (!before.has(k)) detached.add(k);
    }
    leafX = Math.max(mainWidth, leafX);
    const minX = Math.min(LEFT, ...[...pos.values()].map(p => p.x));
    for (const p of pos.values()) p.x += LEFT - minX;
    leafX = Math.max(leafX, ...[...pos.values()].map(p => p.x + p.w));
    let maxY = 0;
    for (const p of pos.values()) maxY = Math.max(maxY, p.y);
    return { pos, detached, width: leafX + LEFT, height: maxY + 70 };
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
      // Keep SVG coordinates aligned when the viewport changes after mount.
      if (globalThis.ResizeObserver) {
        let lastWidth = this.canvas.parentElement.clientWidth;
        this.resizeObserver = new ResizeObserver(() => {
          const width = this.canvas.parentElement.clientWidth;
          if (width !== lastWidth) {
            lastWidth = width;
            if (this.lastStep) this.render(this.lastStep);
          }
        });
        this.resizeObserver.observe(this.canvas.parentElement);
      }
    }

    // 1ステップ描画。ノードと線の座標を同時に更新する。
    // step: {events, marks:{nodeId->"R"|"W"}, statuses:{nodeId->status}, state, caption, code?}
    render(step) {
      this.lastStep = step;
      const st = step.state;
      const latchMarks = step.marks || {};
      const statuses = step.statuses || {};
      const { pos, detached, width, height } = layout(st.nodes, st.root);
      this.canvas.style.width = Math.max(width, this.canvas.parentElement.clientWidth || 0) + "px";
      this.canvas.style.height = height + "px";
      this.svg.setAttribute("width", Math.max(width, this.canvas.parentElement.clientWidth || 0));
      this.svg.setAttribute("height", height);
      this.svg.setAttribute("viewBox", `0 0 ${Math.max(width, this.canvas.parentElement.clientWidth || 0)} ${height}`);

      // --- ノード DOM 更新 ---
      const statusCls = { visited: "visited", target: "target",
        underflow: "underflow", freed: "freed" };
      const seenNodes = new Set();
      this.wanted = new Set();                    // 全ノードが要求するセルid
      for (const id of Object.keys(st.nodes)) {
        const n = st.nodes[id];
        const dying = statuses[id] === "freed";
        // マージ対象は state に残る間は元の位置に留めてフェード
        const p = (dying && this.lastPos.has(id))
          ? this.lastPos.get(id) : pos.get(id);
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
          animate(el, [{ opacity: 0 }, { opacity: 1 }], 260);
          el.style.opacity = "";
        }
        const el = e.el; e.node = n;
        e.dying = dying; e.ghosted = false;   // 復活したらフラグを戻す
        el.className = "bp-node " + (n.leaf ? "leaf" : "internal") +
          (statusCls[statuses[id]] ? " " + statusCls[statuses[id]] : "") +
          (detached.has(id) ? " detached" : "");
        el.style.left = p.x + "px"; el.style.top = p.y + "px";
        el.style.width = p.w + "px"; el.style.height = "30px";
        this.lastPos.set(id, p);
        if (!dying) {
          this.syncCells(id, n, el);
          this.syncBadges(id, n, el, latchMarks);
        } else {
          // セルは吸収先へ飛ぶ (wanted 掃除で未移動分は消える)
          el.querySelectorAll(".latch-badge").forEach(b => b.remove());
        }
      }
      // 消えたノード: freePage で解放されたものだけ 1 ステップ freed
      // ゴーストで残す (◀戻しで「未誕生ノード」が消える場合は即削除)。
      for (const [id, e] of this.nodes) {
        if (seenNodes.has(id)) continue;
        if (e.dying && !e.ghosted && this.lastPos.has(id)) {
          e.el.classList.add("freed");
          e.ghosted = true;
          e.el.querySelectorAll(".latch-badge").forEach(b => b.remove());
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

      // --- ノードと線の座標を同期 ---
      // Geometry changes atomically with edges. Independent node transforms
      // detach SVG endpoints during animation, so step navigation uses stable positions.

      // --- エッジ ---
      const deadIds = new Set(Object.keys(statuses)
        .filter(id => statuses[id] === "freed"));
      this.drawEdges(st, pos, seenNodes, deadIds);
      this.lastStepStatuses = statuses;
      // --- メタ行 ---
      this.meta.innerHTML =
        `root=<b>p${st.nodes[st.root].pid}</b> height=<b>${st.height}</b> rootMu=<b>${step.rootLock || "解放"}</b> ` +
        `freelist=<b>[${st.freelist.join(",")}]</b> nextPID=<b>${st.nextPID}</b>`;
      this.canvas.setAttribute("data-caption", step.caption || "");
      this.lastStepState = st;
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
      const owners = this.lastStep.owners && this.lastStep.owners[id];
      badge.textContent = owners ? owners.map(([t, mode]) => t + ":" + mode).join(" ") :
        lat === "W" ? "W排他" : "R共有";
    }

    // セル(葉ペア / sep / 子ptr)の差分同期。
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
          animate(d, [{ opacity: 0 }, { opacity: 1 }], 240);
        }
        cell.nodeId = id;
        cell.el.className = "bp-cell " + w.cls;
        if (cell.el.textContent !== String(w.text)) cell.el.textContent = w.text;
        el.appendChild(cell.el);
      }
      void seen;   // wanted は render() 側で一括判定
    }

    drawEdges(st, pos, seen, deadIds) {
      while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
      const H = 30;
      deadIds = deadIds || new Set();
      for (const id of seen) {
        const n = st.nodes[id]; if (!n || n.leaf || deadIds.has(id)) continue;
        const p = pos.get(id);
        for (const [ci, cid] of n.children.entries()) {
          const cp = pos.get(cid); if (!cp) continue;
          line(this.svg, p.x + PADX + 2 + CSW / 2 + ci * (CSW + CW + 6), p.y + H, cp.x + cp.w / 2, cp.y);
        }
      }
      // 葉チェーン (next はノード id 文字列)。
      // freed ノードからの stale next は出さない (消える側の旧リンク)。
      for (const id of seen) {
        const n = st.nodes[id];
        if (n && n.leaf && n.next && seen.has(n.next) && !deadIds.has(id)) {
          const a = pos.get(id), b = pos.get(n.next);
          if (a && b) {
            arrow(this.svg,
              a.x + a.w - NXW / 2, a.y + H + 14, b.x + 12, b.y + H + 14);
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
          t.textContent = "root → p" + st.nodes[st.root].pid;
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
    if (globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.animate) el.animate(frames, { duration: ms, easing: "ease-in-out" });
  }
  function line(svg, x1, y1, x2, y2) {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", "#4a5d75"); l.setAttribute("stroke-width", "1.5");
    svg.appendChild(l);
  }
  function arrow(svg, x1, y1, x2, y2) {
    line(svg, x1, y1, x2, y2);
    svg.lastChild && svg.lastChild.setAttribute("stroke", "#3fb97f");
    // 矢印: 進行方向に向いた三角 (斜めも対応)
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;           // 単位ベクトル
    const px = -uy, py = ux;                      // 法線
    const t = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    t.setAttribute("points",
      `${x2},${y2} ${x2 - ux * 7 + px * 3.5},${y2 - uy * 7 + py * 3.5} ` +
      `${x2 - ux * 7 - px * 3.5},${y2 - uy * 7 - py * 3.5}`);
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
      // ヘッダ中の *.go ファイル名を GitHub リンク化
      const headHtml = esc(cfg.code.file).replace(/[\w./-]+\.go/g,
        m => `<a class="gh" href="${ghFileURL(m)}" ` +
             `target="_blank" rel="noopener">${m}</a>`);
      codeEl.innerHTML = `<div class="file">${headHtml}</div>`;
      const pre = document.createElement("pre");
      for (const l of cfg.code.lines) {
        const s = document.createElement("span");
        s.className = "ln"; s.dataset.no = l.no;
        // 行番号は GitHub の #L 行へのリンク (出典ファイルは src() が付与)
        const noHtml = l.file && l.no > 0
          ? `<a class="no gh" href="${ghFileURL(l.file)}#L${l.no}" ` +
            `target="_blank" rel="noopener">${l.no}</a>`
          : `<span class="no">${l.no}</span>`;
        s.innerHTML = noHtml + esc(l.text);
        pre.appendChild(s);
      }
      codeEl.appendChild(pre);
    }

    function show(stepIdx) {
      stepIdx = Math.max(0, Math.min(cfg.steps.length - 1, stepIdx));
      i = stepIdx;
      const st = cfg.steps[i];
      viz.render(st);
      if (cfg.onShow) cfg.onShow(st, viz);
      if (caption) caption.textContent = st.caption || "";
      if (btnP) btnP.disabled = i === 0;
      if (btnN) btnN.disabled = i === cfg.steps.length - 1;
      if (stepno) stepno.textContent = `${i + 1} / ${cfg.steps.length}`;
      if (st.source && codeEl) {
        codeEl.innerHTML = "";
        const head = document.createElement("div"); head.className = "file";
        head.textContent = "対応する Go コード（原文）・行番号から GitHub へ";
        codeEl.appendChild(head);
        for (const section of st.source) {
          const label = document.createElement("div"); label.className = "source-label";
          label.textContent = section.file + " · " + section.symbol;
          codeEl.appendChild(label);
          const pre = document.createElement("pre");
          for (const l of section.lines) {
            const row = document.createElement("span"); row.className = "ln";
            row.dataset.no = l.no; row.dataset.file = section.file;
            row.innerHTML = `<a class="no gh" href="${ghFileURL(section.file)}#L${l.no}" target="_blank" rel="noopener">${l.no}</a>${esc(l.text)}`;
            row.classList.toggle("hl", section.hl.includes(l.no));
            pre.appendChild(row);
          }
          codeEl.appendChild(pre);
        }
      }
      const hl = st.code ? st.code.hl : [];
      if (codeEl && !st.source) {
        codeEl.querySelectorAll(".ln").forEach(el => {
          const no = +el.dataset.no;
          el.classList.toggle("hl", hl.includes(no));
        });
        const first = codeEl.querySelector(".ln.hl");
        if (first) codeEl.scrollTop = Math.max(0, first.offsetTop - codeEl.offsetTop - 60);
      }
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; }
      if (btnA) { btnA.textContent = "▶ 自動再生"; btnA.setAttribute("aria-pressed", "false"); } }
    function play() {
      if (timer) return stop();
      if (i >= cfg.steps.length - 1) show(0);
      if (btnA) { btnA.textContent = "Ⅱ 一時停止"; btnA.setAttribute("aria-pressed", "true"); }
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
    return { show, play, stop, viz, count: cfg.steps.length, steps: cfg.steps };
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // GitHub ソースビュー URL
  const GH_BLOB =
    "https://github.com/ryogrid/concurrent-bp-tree/blob/master/";
  function ghFileURL(f) {
    return GH_BLOB + (f.startsWith("bptree/") ? f : "bptree/" + f);
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
