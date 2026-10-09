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
    const wrap = mk("div", "canvas-wrap", undefined, el);
    mk("div", "bp-canvas", undefined, wrap);
    const side = mk("div", "side", undefined, el);
    const controls = mk("div", "controls", undefined, side);
    mk("button", "b-prev", "◀", controls);
    mk("button", "b-next", "▶", controls);
    mk("button", "b-auto", "▶ 自動", controls);
    mk("button", "b-reset", "⟲", controls);
    mk("span", "stepno", "", controls);
    mk("div", "caption", "", side);
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
      const lines = new Set(cfg.hlAlways || []);
      for (const e of s.events)
        (cfg.hl[e.t] || []).forEach(n => lines.add(n));
      (cfg.hl["tag:" + s.tag] || []).forEach(n => lines.add(n));
      if (lines.size) s.code = { hl: [...lines] };
    }
    const mount = mountTopic(el, {
      steps, code: cfg.code, interval: cfg.interval || 950,
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
