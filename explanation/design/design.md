# 解説ビジュアライゼーション v2 — 詳細設計

## 1. 目的と要件

現行の `explanation/index.html` は手書き SVG 図のステップ送りだった。
本フェーズでは **B+木ビジュアライゼーション・コンポーネントを自作** し、
実際の Go 実装と同じアルゴリズムで動作する JS シミュレータを駆動して、
以下を**要素レベルのアニメーション**付きで詳細に解説する。

対象トピック (ユーザー指定 9 項目):

| # | トピック | 対応 Go コード |
|---|---------|--------------|
| 1 | 要素探索 | `tree.go get`, `node.go leafFindPos/internalFindChildIdx` |
| 2 | 要素挿入 | `put` (upsert), `leafInsertAt`, `leafSetPair` |
| 3 | 要素挿入にともなうノード挿入 | `internalInsertKeyAt`, `allocPage` |
| 4 | 要素挿入にともなうノードのスプリット | `leafInsertSplit`, `internalInsertSplit` |
| 5 | 要素削除 | `leafRemoveAt` |
| 6 | 削除時のノードマージとノード削除 | `leafMergeInto`, `internalMergeInto`, `leafBorrowFrom*`, `internalBorrowFrom*`, `freePage` |
| 7 | ノード分割にともなう木の構造変化 | split 伝播, `internalInitRoot` (height++) |
| 8 | ノード挿入にともなう木の構造変化 | 親への child 追加, nextLeafPID 配線 |
| 9 | ノードマージにともなう木の構造変化 | 親からの child 削除, ルート縮小 (height--) |

## 2. アーキテクチャ決定

### 2.1 ライブラリ選定: 自作 `bptree-viz` (外部依存ゼロ)

検討した選択肢:

- **D3.js**: データ駆動 DOM の定番だが、ツリー用の組込みレイアウトは
  ノード=点の粒度で、**ノード内の要素セルが別ノードへ移動する**
  アニメーション (借用・分割) を表現するには自前の実装が結局必要。
  CDN 依存も入る。
- **vis-network / cytoscape.js**: グラフ自動レイアウトだがノード内
  要素の概念がなく、不適。
- **GSAP**: アニメーションは強力だが、ブラウザ標準の
  **Web Animations API (WAAPI)** で同等の補間が書ける。依存ゼロを優先。
- **自作**: B+木モデル + レイアウト + FLIP アニメーションを持つ
  軽量コンポーネント (~500行)。要件への適合度が最も高い。

**結論: 自作**。vanilla JS + SVG(エッジ) + DOM(要素セル) + WAAPI。
オフラインで完全に動作し、外部ライブラリの学習コストを読者に課さない。

### 2.2 2層構成: シミュレータ + レンダラ

```
bptree-sim.js   アルゴリズム層 — Go 実装の直訳に近いミニ B+木。
                操作ごとに「イベント列」を生成する (描画はしない)。
bptree-viz.js   描画層 — シミュレータの状態とイベントを受け取り、
                DOM/SVG に反映 + WAAPI アニメーション。
scenario-*.js   トピック層 — 「このキー列を操作する」シナリオ定義。
```

なぜシミュレータを分けるか:

- 描画コードとアルゴリズムの混在を避けられる
- **シミュレータは Node.js でユニットテスト可能** (DOM 不要)
- 各ステップの「状態」が明示的になり、コード対応表を正確に作れる

### 2.3 シミュレータの忠実度

Go コードと**関数名・分岐構造を対応させた縮小版**を実装する:

- 容量定数を縮小: `MAX_LEAF=4` / `MIN_LEAF=2`、
  `MAX_INTERNAL=4` / `MIN_INTERNAL=2` (実装は 510/255)。
  画面上で分裂・併合が少数の挿入で発生するようにする。
  ページ上で対応関係を明示 (4↔510, 2↔255)。
- 同一関数名: `leafFindPos`, `internalFindChildIdx`, `leafInsertAt`,
  `leafInsertSplit`, `internalInsertKeyAt`, `internalInsertSplit`,
  `leafRemoveAt`, `leafBorrowFromRight/Left`, `internalBorrowFromRight/Left`,
  `leafMergeInto`, `internalMergeInto`。
- ラッチイベントを発行: `latch(nodeID, "W"|"R")`, `unlatch(nodeID)`,
  `releaseAncestors` (クラビングの解放)、`restart` (TryLock 失敗)。
- ページ管理: `allocPage`/`freePage` で PageID を採番し、
  解放ページはフリーリストへ (再割当される) —— Go 実装と同じ。

各ステップは `{ op, events, caption, codeHL }` で表現。
`codeHL` はページ側の Go コードパネルの該当行を指す。

### 2.4 レンダラ (`bptree-viz.js`)

- ノード = 絶対配置の `<div>` (リーフ=緑枠, 内部=橙枠)。
  内部: `[c0] k0 [c1] k1 [c2] …`、リーフ: `(k,v)` セル列 + next 矢印。
- **DOM 同一性**: ノードは `(pageID, generation)` でキー付けする。
  `freePage` された PageID がフリーリスト経由で再割当されても、
  新しいインスタンスは別 DOM 要素になり、旧ゴーストから
  FLIP アニメーションする事故を防ぐ (freelist 再利用が実装に存在)。
  要素セルも同様に `(nodeInstance, slotKind, slotIndex)` 等で
  一意化し、**同一キー値のリーフ pair と親の分離キーは別エントリ**
  として扱う。
- エッジ (親→子, nextLeafPID) = `<svg>` 線分。レイアウトは
  リーフ等間隔 + 親は子の重心上、の簡易ツリーレイアウト。
  高さ3 (葉 ~20 枚) ではキャンバスを横スクロール可にする。
  ルートに未接続の一時ノード (分裂直後の新部分木、freePage 直前の
  マージ犠牲ノード) は木の下の「孤立レーン」にミニ木として配置し
  破線枠で示す — 配置しないとノードも接続線も描画できない。
  freed マーク済みノードは最後の位置でフェードし、その stale な
  外向きエッジは描画しない。
- **要素移動アニメーション**: 各エントリは安定 ID を持つ DOM 要素。
  状態遷移時に旧位置→新位置を WAAPI `element.animate` で補間 (FLIP)。
- **ステータス表現**: ノード枠色 = visited(青)/target(黄)/underflow(赤枠)/
  freed(点線+フェード); ラッチバッジ = R(青)/W(赤); 要素 =
  insert(緑フラッシュ)/moved(スライド)/deleted(消滅)。
- イベントは**フェーズ単位でグルーピング**して1ステップ=1まとまり
  (降下中の latch/unlatch 列はまとめる等。無調整だと高さ3の分裂伝播で
  20ステップ超になって冗長)。◀ ▶ + 自動再生 + キャプション +
  コードハイライト同期 (現行ページと同じ UX)。
- 規模見積り: sim ~400行 + viz ~700行 + ページ群 ~600行程度を想定。

## 3. ファイル構成

```
explanation/
  design/
    design.md      本ファイル
    scenarios.md   トピック別シナリオ詳細設計
    TODO.md        進捗管理
  index.html       ポータル (トピック一覧 + 概要リンク)
  overview.html    現行 index.html の内容 (全体概観, 軽量図版)
  shared/
    viz.css        ノード/要素/バッジ/ページレイアウト
    bptree-sim.js  縮小版 B+木シミュレータ (DOM 非依存, Node でも実行可)
    bptree-viz.js  レンダラ + アニメーション + ステップエンジン
  topics/
    get.html       1. 要素探索
    insert.html    2. 要素挿入
    node-insert.html   3. 挿入にともなうノード挿入
    split.html     4. 挿入にともなうスプリット
    delete.html    5. 要素削除
    merge.html     6. 削除時のマージとノード削除
    structure.html 7-9. 木構造変化 (3 シナリオをタブ切替)
  test/
    sim.test.js    node --test によるシミュレータ単体テスト
    viz.smoke.js   DOM シムによるレンダラのスモークテスト
```

## 4. トピックページ共通レイアウト

```
+------------------------------------------------------+
| ヘッダ: タイトル + トピックナビ (前/次/ポータル)          |
+------------------------------------------------------+
| 導入文 (何を見せるか, 対応する Go 関数名)                |
+------------------------------+-----------------------+
| 可視化キャンバス                | Go コードパネル         |
| (アニメーション)                | (該当行ハイライト)       |
|                              |                       |
+------------------------------+-----------------------+
| ◀ ▶ 自動再生  Step n/N        |                       |
| キャプション (何が起きたか)      |                       |
+------------------------------------------------------+
| 定数対応表 / 補足ノート                                 |
+------------------------------------------------------+
```

## 5. シミュレータ API

```js
const sim = new BptreeSim({maxLeaf: 4, maxInternal: 4});
// 各呼び出しはイベント列を返す (viz が再生):
sim.get(key)       → events[]
sim.put(key, val)  → events[]
sim.del(key)       → events[]
// イベント例:
//   {t:"latch", node:"p5", mode:"W"}
//   {t:"descend", from:"p1", to:"p5", ci:2}
//   {t:"leafInsert", node:"p5", pos:1, key:25, val:...}
//   {t:"split", left:"p5", right:"p9", sep:30}
//   {t:"copyUp", node:"p2", pos:0, key:30, child:"p9"}
//       ← 葉分裂: キーは右葉に残り「複製」が親へ (leafInsertSplit)
//   {t:"promoteUp", node:"p2", pos:0, key:70, child:"p10"}
//       ← 内部分裂/借用: キーが子から消えて親へ「移動」 (internalInsertSplit)
//   {t:"borrow", dir:"right", donor:"p6", recv:"p5", key:..}
//   {t:"merge", dst:"p5", src:"p6"}
//   {t:"free", node:"p6"}
//   {t:"rootGrow", newRoot:"p10"} / {t:"rootShrink", old:"p1"}
//   {t:"unlatchAll"} / {t:"restart", why:"trylock"}
//   {t:"trylock", node:"p4", ok:false}  ← シナリオが指定した失敗を再現
```

シナリオ定義では「どの操作をどの順で叩くか」+ 各操作に紐づく
キャプションとコード行指定のみを書き、イベントはシミュレータが生成する。
これにより**図が常にアルゴリズムの実動作と一致する**。

TryLock 失敗など並行性特有のイベントはシナリオが
`del(k, { trylockFail: true })` で注入できるようにする
(説明のための演出用フック —— 実アルゴリズムではタイミング依存)。
注入リトライ時は Go と同じ挙動を再現する: 再降下では削除対象が
既に消えて `found=false` でも `ok = ok || removed` で成功を返し、
アンダーフローのリバランスは継続する (キャプションで明示)。

シミュレータは Go の delete 伝播ループを忠実に移植し、
リトライ中断で残留し得る**退化親 (pn==0, 単一子の内部ノード) 分岐**
(tree.go の `pn==0` ガード相当) も含める。

## 6. テスト方針

- `sim.test.js`: `node --test` で実行。検証内容:
  - 逐次 insert/delete の後、全キーの昇順走査がオラクル Map と一致
  - split/borrow/merge 後もソート不変条件・親子整合が保たれる
  - ルート成長/縮小で高さが正しく変化
  - イベント列に latch の取得→解放が対で出る (リーク検査)
- `viz.smoke.js`: 簡易 DOM シム (前回同様) で全トピックページの
  シナリオを全ステップ再生し、例外・未定義参照がないことを確認。
- **シナリオ正当性テスト**: 各シナリオのデモ操作が、設計した
  イベント種別 (`split`/`borrow`/`merge`/`rootGrow`/`rootShrink` 等) を
  実際に発行することを `sim.test.js` で機械的に検証する
  (準備不足で分裂しない等のシナリオ誤りをテストが検出できる)。
- 手動確認: `python3 -m http.server` + ブラウザプレビューで目視。

script は ES module ではなく通常の `<script src>` タグで読み込み、
`file://` で直接開いても動く構成にする (外部依存ゼロ方針と一致)。

## 7. 実施計画 (explanation/design/TODO.md と対応)

1. 設計ドキュメント作成 → SWE モデル reviewer レビュー → 対応 → commit/push
2. `bptree-sim.js` + `sim.test.js` → `node --test` 緑 → commit
3. `bptree-viz.js` + `viz.css` + ステップエンジン + `viz.smoke.js` → commit
4. トピックページ 7 本 + `index.html` ポータル + `overview.html` 退避 →
   `viz.smoke.js` 全パス → commit
5. 新規成果物全体を SWE モデル reviewer でレビュー → 対応 → commit/push

## 8. 却下した代替案

- **D3 導入**: ノード内要素移動は結局自前になるため。
- **既存 index.html を直接拡張**: 図版が手書き形状のままでは
  要素移動アニメーションが作りにくい。overview.html として残し、
  新トピックはコンポーネント駆動で別ページにする。
- **iframe で Go 実装を直接可視化**: WASM 化は教材として過剰。
  JS シミュレータの方がコード対応の説明に適する。
