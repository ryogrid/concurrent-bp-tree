# TODO — 並行 B+ Tree KVS 実装タスク進捗

進め方: 各タスクは「実装 → `gofmt -l .` / `go vet ./...` / `go test ./... -race` → swe モデルの devin サブエージェント（reviewer / subagent_general）による差分レビュー → 指摘対応 → commit & push」の順で行い、完了したら `[x]` にする。
詳細は `design.md` の §9 実施計画を参照。

- [x] 0. リポジトリ初期化、origin 設定
- [x] 1. 設計ドキュメント（design.md, TODO.md）作成・レビュー・コミット
- [x] 2. 基盤層: `const.go`, `types.go`, `page.go`, `meta.go`, `disk.go`, `buffer.go`, `freelist.go`, `tree.go`(スケルトン) + テスト
- [x] 3. バッファプール: `buffer.go` + テスト（タスク2と併せて実装・レビュー済み）
- [ ] 4. ノードプリミティブ: `node.go` + テスト
- [ ] 5. Get / Put（split・ルート成長）: `tree.go` 前半 + テスト
- [ ] 6. Delete（借用/マージ・ルート縮小）: `tree.go` 後半 + テスト
- [ ] 7. RangeScan + テスト
- [ ] 8. 並行・永続化ストレステスト（`concurrent_test.go`, -race 実行）
- [ ] 9. 解説 HTML: `explanation/index.html` 作成・レビュー・コミット

## レビュー記録

| タスク | レビュー結果 | 対応 |
|--------|--------------|------|
| 1. 設計ドキュメント | must-fix 5件指摘（内部分裂の説明文誤り、スクラッチ分割、writeMeta ロック規約、ロック順序記述、エラー時解放規則） | design.md を修正して全件対応 |
| 2. 基盤層 | must-fix 2件（writeMeta のメタフレーム非ラッチ→torn write リスク、エビクションテストの無意味なアサート） | writeMeta でフレーム W ラッチ化、テスト修正。あわせて decodeMeta 範囲検証、unpin 負 pin ガード、closed 設定順、LRU/永続化テスト等の指摘も取込 |
