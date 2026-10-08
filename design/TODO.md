# TODO — 並行 B+ Tree KVS 実装タスク進捗

進め方: 各タスクは「実装 → `gofmt -l .` / `go vet ./...` / `go test ./... -race` → swe モデルの devin サブエージェント（reviewer / subagent_general）による差分レビュー → 指摘対応 → commit & push」の順で行い、完了したら `[x]` にする。
詳細は `design.md` の §9 実施計画を参照。

- [x] 0. リポジトリ初期化、origin 設定
- [x] 1. 設計ドキュメント（design.md, TODO.md）作成・レビュー・コミット
- [x] 2. 基盤層: `const.go`, `types.go`, `page.go`, `meta.go`, `disk.go`, `buffer.go`, `freelist.go`, `tree.go`(スケルトン) + テスト
- [x] 3. バッファプール: `buffer.go` + テスト（タスク2と併せて実装・レビュー済み）
- [x] 4. ノードプリミティブ: `node.go` + テスト
- [x] 5. Get / Put（split・ルート成長）: `tree.go` 前半 + テスト
- [x] 6. Delete（借用/マージ・ルート縮小）: `tree.go` 後半 + テスト
- [x] 7. RangeScan + テスト
- [x] 8. 並行・永続化ストレステスト（`concurrent_test.go`, -race 実行）
- [ ] 9. 解説 HTML: `explanation/index.html` 作成・レビュー・コミット

## レビュー記録

| タスク | レビュー結果 | 対応 |
|--------|--------------|------|
| 1. 設計ドキュメント | must-fix 5件指摘（内部分裂の説明文誤り、スクラッチ分割、writeMeta ロック規約、ロック順序記述、エラー時解放規則） | design.md を修正して全件対応 |
| 2. 基盤層 | must-fix 2件（writeMeta のメタフレーム非ラッチ→torn write リスク、エビクションテストの無意味なアサート） | writeMeta でフレーム W ラッチ化、テスト修正。あわせて decodeMeta 範囲検証、unpin 負 pin ガード、closed 設定順、LRU/永続化テスト等の指摘も取込 |
| 4. ノードプリミティブ | LGTM + 契約ドキュメント不足1件（leafInsertSplit の兄弟リンク配線は呼び出し側責任） | ドキュメント追加 + 境界テスト追加 |
| 5. Get/Put | LGTM + RISK 2件（フレーム枯渇デッドロック、内部分裂のテスト不足） | opSlots セマフォ（上限20）で枯渇デッドロックを構造的に排除、高さ3テスト追加、design.md 更新 |
| 6+7. Delete/RangeScan | BUG 2件（TryLock 失敗時に非保持ラッチを Unlock→panic/ラッチ奪取、pn==0 退化親で兄弟ポインタがゴミ化）、RISK（errRestart が内部ノード残留アンダーフローを残す） | TryLock 失敗時は unpin のみ、pn==0 ガード追加、残留アンダーフローは lazy として文書化、retryOp が最終エラーを返すよう修正 |
| 8. 並行・永続化ストレステスト | テスト自体は正しいがカバレッジ不足2件（エビクションが実際には発生していない、高さ3での内部ノード merge/borrow が未到達） | プリロードを約16万キーに増量し常時エビクション発生、高さ3チャーンテスト追加（内部マージ・ルート縮小をスキャン並行下で検証）。-race×3 全パス |
