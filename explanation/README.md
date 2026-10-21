# B+木の解説サイト

`index.html` をブラウザで開きます。配信・ビルド・外部CDNへの接続は不要です。

## 構成

- `overview.html`: ページ、バッファプール、pin、ラッチ、永続性の範囲
- `topics/latching.html`: コードを読む前のクラブラッチング導入。2スレッドの取得・待機・解放を5例で追う
- `topics/rebalance.html`: 高さ4の木でマージの連鎖・ルート縮小・内部ノードの借用を追う。全体図から詳細へ移動可能
- `topics/variations.html`: R先行の更新方式やB-link木など、別のB+木設計を紹介
- `shared/latching-viz.js`: ラッチ互換性と保持を検査しながら代表的な実行順を記録
- `shared/rebalance-scenarios.js`: 大きな木の準備データと操作（解説とテストで共有）
- `topics/*.html`: 各操作の解説、初期データ、再生する操作
- `shared/bptree-sim.js`: 容量4/2に縮小した操作モデルと状態スナップショット
- `shared/bptree-viz.js`: スナップショットからノード・エッジ・ラッチを描画
- `shared/lesson.js`: ステップからGoの関数・処理箇所への対応
- `shared/go-source.js`: Goファイルから自動生成した原文。直接編集しない

図は各場面の処理後の状態を表示します。ページラッチはR/Wバッジ、rootMuは下部のメタ情報に表示します。枠の強調色は注目箇所であり、ラッチを意味しません。木にまだ接続されていない部分木は下段、解放対象は薄い破線枠で表示します。

このモデルは実Goコードの実行や並行スケジューラではありません。TryLock失敗は説明用の注入です。実際のディスクI/O、バッファ退避、I/Oエラーは省略しています。Go側の修正時は、モデルも確認してください。

## 検証

リポジトリのルートから実行します。

```sh
go test -race ./...
node --test explanation/test/*.js
node explanation/scripts/generate-source.js --check
```

Goソースを変更したら、次を実行して生成ファイルもcommitします。関数名や対応する文が変わった場合は `lesson.js` の対応表を更新します。見つからない対応はテストでエラーになります。

```sh
node explanation/scripts/generate-source.js
```

実ブラウザ検証には開発用のPlaywrightを使います。サイト利用者には不要です。

```sh
npm ci --prefix explanation
cd explanation
npx playwright install chromium
npm run test:browser
```

ブラウザ検証は全12ページを1440px/390px幅で開き、全デモの順送り・逆送り、SVG領域、エッジ本数と座標、ラッチバッジ、コード抜粋、操作ボタンを検査します。

GitHub Pagesはmasterへの解説ファイルのpushで配信されます。CIでは公開前にソースの同期とNodeテストを検査します。
