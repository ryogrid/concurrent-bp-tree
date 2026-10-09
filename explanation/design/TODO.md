# 解説ビジュアライゼーション v2 — TODO

凡例: `[ ]` 未着手 / `[x]` 完了。各タスクは実装 → 検証 → レビュー →
指摘対応 → commit & push のサイクルで進める。

## タスク

- [x] 0. 設計ドキュメント作成 (`design.md`, `scenarios.md`, `TODO.md`)
- [x] 1. 設計レビュー (swe-2 系 reviewer サブエージェント) → 対応 → commit & push
- [x] 2. `shared/bptree-sim.js` シミュレータ + `test/sim.test.js` (`node --test` 15件緑)
- [x] 3. `shared/bptree-viz.js` + `shared/viz.css` + `shared/topics.js` ステップエンジン + `test/viz.smoke.js` (DOMシム全ステップ描画)
- [x] 4. トピックページ 7 本 (`topics/*.html`) + `index.html` ポータル化 + `overview.html` 退避
- [ ] 5. 全成果物レビュー (swe-2 系) → 対応 → commit & push
- [ ] 6. 最終確認: ブラウザ表示目視、全テスト緑、TODO 全完了

## レビュー記録

| タスク | レビュー結果 | 対応 |
|--------|--------------|------|
| 1. 設計ドキュメント | must-fix 4件（get(45) が実はミス、node-insert の準備が満杯葉でない、promote が copy-up/move-up を混同、DOM 同一性が PageID 再利用を考慮していない）＋RISK（trylock-fail リトライ時の found=false 挙動、pn==0 分岐、全デモのキー列未確定） | 全デモのキー列を手計算で確定・検証、copyUp/promoteUp イベント分離、ノード DOM を (pageID,generation) で一意化、リトライ挙動をシナリオ・sim 仕様に明記、pn==0 移植を明記、シナリオ→イベント検証テストを追加 |
