/* topics.js — トピックページ共通のステージ組立てヘルパ。
 * buildDemo(el, cfg) で デモ1個分の DOM (canvas+controls+caption+codepanel)
 * を構築し、シミュレータを走らせて mountTopic する。
 *
 * cfg:
 *   prep(sim)   : 準備操作 (ステップは捨てる。木構築のみ)
 *   ops         : [sim=>{steps}, ...] デモ操作列 (順に実行し steps を連結)
 *   caption0    : 初期状態ステップのキャプション
 *   code        : {file, lines:[{no,text}]} コードパネル内容
 *   hl          : {eventType| "tag:"+tag : [行番号...]} ハイライト対応表
 *   hlAlways    : 全ステップ共通でハイライトする行
 */
"use strict";
(function () {
  function mk(tag, cls, text, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function buildDemo(el, cfg) {
    el.classList.add("stage");
    const legend = mk("p", "demo-legend", "緑枠＝葉 ／ 橙枠＝内部ノード ／ 実線＝子への参照 ／ 緑の矢印＝次の葉。R＝共有ラッチ、W＝排他ラッチ。バッジなし＝この操作はラッチを保持していません。p番号＝ページID、破線枠＝親へ未接続のノード／解放対象。横長の図は横にスクロールできます。", el);
    const wrap = mk("div", "canvas-wrap", undefined, el);
    mk("div", "bp-canvas", undefined, wrap);
    const overview = cfg.overview ? mk("div", "tree-overview", undefined, el) : null;
    const side = mk("div", "side", undefined, el);
    const controls = mk("div", "controls", undefined, side);
    mk("button", "b-prev", "◀ 戻る", controls);
    mk("button", "b-next", "次へ ▶", controls);
    mk("button", "b-auto", "▶ 自動再生", controls);
    mk("button", "b-reset", "最初から", controls);
    mk("span", "stepno", "", controls);
    const caption = mk("div", "caption", "", side);
    caption.setAttribute("aria-live", "polite");
    mk("div", "codepanel", "", side);
    const sim = new BptreeSim();
    if (cfg.prep) cfg.prep(sim);
    const steps = [{
      tag: "init", caption: cfg.caption0 || "準備完了状態",
      events: [], marks: {}, statuses: {}, state: sim.snapshot(),
    }];
    for (const op of cfg.ops) steps.push(...op(sim).steps);
    // イベント種別 → コード行ハイライト
    for (const s of steps) {
      if (cfg.autoSource) { s.source = sourceFor(s, cfg.operation); continue; }
      const lines = new Set(cfg.hlAlways || []);
      for (const e of s.events)
        (cfg.hl[e.t] || []).forEach(n => lines.add(n));
      (cfg.hl["tag:" + s.tag] || []).forEach(n => lines.add(n));
      if (lines.size) s.code = { hl: [...lines] };
    }
    const mount = mountTopic(el, {
      steps, code: cfg.code, interval: cfg.interval || 950,
      onShow: overview ? (step, viz) => {
        overview.innerHTML = "";
        mk("p", "", `全体図：高さ ${step.state.height} ／ ${Object.keys(step.state.nodes).length} ページ。ページを選ぶと上の詳細図へ移動します。`, overview);
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 1000 240");
        svg.setAttribute("aria-label", "木全体のページ配置");
        overview.appendChild(svg);
        const entries = Object.entries(step.state.nodes).filter(([id]) => viz.lastPos.has(id));
        const maxX = Math.max(...entries.map(([id]) => {const p=viz.lastPos.get(id);return p.x+p.w;}));
        const maxY = Math.max(...entries.map(([id]) => viz.lastPos.get(id).y)) || 1;
        const point = id => {const p=viz.lastPos.get(id);return [15+(p.x+p.w/2)/maxX*970,20+p.y/maxY*195];};
        for (const [id,n] of entries) for (const child of n.children || []) {
          if (!viz.lastPos.has(child)) continue;
          const a=point(id), b=point(child), line=document.createElementNS(ns,"line");
          for (const [k,v] of Object.entries({x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:"#7890a8"})) line.setAttribute(k,v);
          svg.appendChild(line);
        }
        for (const [id,n] of entries) {
          const [x,y]=point(id), dot=document.createElementNS(ns,"circle");
          for (const [k,v] of Object.entries({cx:x,cy:y,r:7,fill:step.marks[id]==="W"?"#ff8585":step.marks[id]==="R"?"#70cfff":n.leaf?"#81daa8":"#e8b76b",tabindex:0,role:"button","aria-label":id+" キー "+n.keys.join(",")})) dot.setAttribute(k,v);
          const focus=()=>{const p=viz.lastPos.get(id);wrap.scrollLeft=Math.max(0,p.x+p.w/2-wrap.clientWidth/2);};
          dot.onclick=focus;
          const title=document.createElementNS(ns,"title");
          title.textContent=id+" キー "+n.keys.join(","); dot.appendChild(title);
          dot.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();focus();}};
          svg.appendChild(dot);
        }
      } : undefined,
    });
    el._mount = mount;          // テスト/デバッグ用に露出
    return sim;
  }

  // Go ソース抜粋を {no,text,file} 行配列にする簡易 DSL:
  //   src("tree.go", 245, `func (t *Tree) get...`) — 連番を振る。
  //   file は mountTopic が行番号の GitHub リンク生成に使う。
  function src(file, start, text) {
    return {
      file,
      lines: text.replace(/\n$/, "").split("\n")
        .map((t, i) => ({ no: start + i, text: t, file })),
    };
  }

  if (typeof globalThis !== "undefined") {
    globalThis.buildDemo = buildDemo;
    globalThis.src = src;
  }
})();
