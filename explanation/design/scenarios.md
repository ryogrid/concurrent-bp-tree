# シナリオ詳細設計 (トピック別)

シミュレータの縮小定数: `MAX_LEAF=4, MIN_LEAF=2, MAX_INTERNAL=4, MIN_INTERNAL=2`
(実装の 510/255 に対応)。葉分裂は 5 エントリを**非対称に 左2/右3** へ分割し
`keys[2]` (=右葉の最小キー) をコピーアップ、内部分裂は 5 keys/6 children を
対称に 2/昇格`keys[2]`/2 に分割 —— Go 実装 (葉 255/256, 内部 255/昇格/255)
と同構造。

各シナリオは「準備操作列 (木を構築) → デモ操作 (イベント列を再生)」。
キャプションはフェーズごと (降下/ラッチ/変更不要点/分裂/伝播/解放) に付く。
下記のキー列はすべて縮小定数で逐一手計算・検証済み。

## 基準木

`put([10,20,30,40,50,60,70])` の結果:

```
root [30,50]  (内部, 3子)
  ├ L1 [10,20]
  ├ L2 [30,40]
  └ L3 [50,60,70]
```

高さ2、全葉が MIN=2 以上。以後これを「基準木」と呼ぶ。

`put([10,...,70, 75,80,85,90,95,100])` の結果 (高さ3):

```
root [70]
  ├ Ia [30,50] → L1[10,20] L2[30,40] L3a[50,60]
  └ Ib [80,90] → L4a[70,75] L5a[80,85] L6[90,95,100]
```

## get.html — 1. 要素探索

- 準備: 基準木。
- デモ A: `get(40)` (ヒット)
  1. `rootMu.RLock` + ルート fetch + R ラッチ
  2. ルートで `internalFindChildIdx`: 40 ≥ 30 かつ < 50 → child[1] = L2
  3. L2 を R ラッチ → 親解放 (カップリング)
  4. 葉で `leafFindPos`: pos=1, found → 値返却
- デモ B: `get(45)` (ミス) — 同じ L2 で pos=2=末尾 → `found=false`。
  ヒットと同じ経路で分岐が違うことを対比。
- コードパネル: `tree.go get()`, `node.go leafFindPos`

## insert.html — 2. 要素挿入

- 準備: 基準木。
- デモ A: `put(45, v)` — L2 [30,40] は空きあり
  1. `rootMu.Lock` + ルート W ラッチ
  2. W クラビング下降: L2 が安全 (2<4) → 祖先ラッチ一括解放を強調
  3. `leafFindPos` → found=false, pos=2 → `leafInsertAt` (右シフト)
  → L2 [30,40,45]
- デモ B: `put(40, v2)` — found=true → `leafSetPair` で上書き
- コードパネル: `tree.go put` 降下部, `leafInsertAt/leafSetPair`

## node-insert.html — 3. 要素挿入にともなうノード挿入

- 焦点: 分裂で新ページが割当られ親に (sep, childPID) が挿入される瞬間。
- 準備: 基準木 + `put(75)` → L3 が [50,60,70,75] で**満杯 (4/4)**。
  ※ 分裂を起こすには挿入時点で葉が満杯である必要がある (3/4 では
  吸収されるだけでノード挿入は起きない)。
- デモ: `put(80)` →
  1. L3 満杯 → `allocPage` (新 PageID 採番; フリーリスト空なら
     `nextPageID++` で暗黙のファイル伸長)
  2. `leafInsertSplit`: L3 [50,60] / 新 L4 [70,75,80], sep=70
  3. `right.next = cur.next; cur.next = rightPID` 配線
  4. `internalInsertKeyAt(root, ci=2, 70, L4)` — 親のキー/子配列を
     シフトして挿入 → root [30,50,70] 4子
- コードパネル: `tree.go put` 分裂〜伝播部, `internalInsertKeyAt`,
  `freelist.go` の割当/再利用

## split.html — 4. 要素挿入にともなうノードのスプリット

- デモ A: 葉分裂 — 上記 `put(80)` を葉レベルで詳細に:
  scratch[5] 構築 → 左2/右3 書き戻し → 分離キー = 右葉の最小キー
  (コピーアップ: キーは右葉に**残る**)。
- デモ B: 内部分裂 — 準備 `put([10..70,75,80,85,90,95])` で
  root=[30,50,70,80] (満杯), 葉列 L1[10,20] L2[30,40] L3a[50,60]
  L4a[70,75] L5[80,85,90,95]。
  `put(100)` → L5 分裂 ([80,85]|[90,95,100], sep=90) →
  `internalInsertKeyAt` 先のルートが満杯 → `internalInsertSplit`:
  scratch keys[30,50,70,80,90] + children 6 → 左 [30,50] / 昇格 70 /
  右 [80,90] → 新ルート [70] で高さ 2→3。
  昇格は**ムーブ** (キーは子から消える) —— 葉のコピーアップとの
  対比を明示。
- コードパネル: `leafInsertSplit`, `internalInsertSplit`

## delete.html — 5. 要素削除

- 準備: 基準木。
- デモ A: `del(70)` → L3 [50,60,70] → [50,60] で Min=2 維持 →
  `leafRemoveAt` のみで終了 (リバランス不要)。
- デモ B: `del(999)` → 右端葉へ降下するが found=false。
  安全な葉に到達した時点で祖先ラッチは早期解放される様子を強調。
- コードパネル: `tree.go delete` 降下〜葉削除部, `leafRemoveAt`

## merge.html — 6. 削除時のノードマージとノード削除

- デモ A (右借用): 準備 = 基準木 + `put(45)` →
  L2 [30,40,45]。`del(20)` → L1 [10] でアンダーフロー (1<2)。
  ci=0 < pn → 右兄弟 L2 (3>2) はブロッキング Lock で借用可能 →
  `leafBorrowFromRight`: L2 の先頭 30 を L1 末尾へ → L1[10,30],
  L2[40,45], 親 sep[0] = L2 の新先頭 = 40 → root [40,50]。
- デモ B (左借用 + TryLock): 準備 = 基準木 + `put(45)` + `del(70)` →
  L3 [50,60]。`del(60)` → L3 [50] アンダーフロー、ci=pn →
  左兄弟 L2 [30,40,45] に `TryLock` → 成功時 `leafBorrowFromLeft`:
  45 を L3 先頭へ → L3[45,50], 親 sep[1] = 45 → root [40,45]。
  **失敗演出**: `{ inject: "trylock-fail" }` で 1 回目失敗 →
  全ラッチ解放 → `errRestart` → 操作最初から。**注意点として明示**:
  リトライ2回目の降下ではキー 60 は既に消えている (`found=false`) が、
  `Delete` は `ok = ok || removed` で削除成功を返し、残った
  アンダーフロー葉のリバランスは継続される (Go の挙動と同じ)。
- デモ C (右マージ): 準備 = 基準木。`del(20)` → L1[10] アンダーフロー、
  右兄弟 L2[30,40] は Min (借用不可) → `leafMergeInto(L1,L2)` →
  L1[10,30,40], `L1.next = L2.next`, `internalRemoveKeyAt(root,0)` →
  root [50], L2 を `freePage` → フリーリスト push を表示。
- デモ D (左マージ): 準備 = 基準木 + `del(70)` → L3[50,60]。
  `del(60)` → L3[50] アンダーフロー、ci=pn → `TryLock` L2[30,40]
  (Min, 借用不可) → `leafMergeInto(L2,L3)` → L2[30,40,50],
  `internalRemoveKeyAt(root,1)` → root [30], L3 を freePage。
- デモ E (内部マージ): 準備 = 高さ3木 (`put` 100 まで)。
  `del(20)` → L1 アンダーフロー → L2 を右マージで吸収 →
  Ia が [50] 1キー (アンダーフロー) → 上へ伝播 → 右兄弟 Ib [80,90]
  は Min → `internalMergeInto(Ia, Ib, sep=70)`: **分離キー 70 が
  親から引き下ろされ** Ia [50,70,80,90] 5子 → ルートが 0キー1子 →
  **ルート縮小 height 3→2**、Ib と旧ルートを freePage。
- コードパネル: `tree.go delete` アンダーフロー部,
  `leafMergeInto/internalMergeInto/borrow*` 各種

## structure.html — 7-9. 木構造の変化 (3 シナリオ, タブ切替)

### タブ1: 分割による構造変化 (height++)
- 準備: `put([10,20,30,40])` → 葉ルート [10,20,30,40] 高さ1。
- デモ: `put(50)` → 葉分裂 → 親なし → `internalInitRoot`:
  新内部ルート [30]、子 L1[10,20] L2[30,40,50]、
  `meta.rootPageID` 更新 + `meta.height++`。高さ 1→2 の瞬間。
- 補足: 高さ3木への伝播は split.html デモB を参照。

### タブ2: ノード挿入による構造変化
- node-insert.html の `put(80)` を構造変化の観点で:
  before root[30,50] 3子 → after root[30,50,70] 4子。
  「親にキー+子ポインタが挿入される = 木に新しい分岐が足される」を
  カバー範囲の帯表示とともに強調。

### タブ3: マージによる構造変化 (height--)
- 準備: `put([10..50])` → root [30] → L1[10,20], L2[30,40,50] 高さ2。
- デモ: `del(40)`, `del(50)` → L2[30] アンダーフロー → 左マージで
  L1[10,20,30] → ルート 0キー1子 → `meta.root = L1` (リーフルート),
  `height--` → 高さ 2→1。旧ルートと L2 はフリーリストへ。

## 共通: コード対応表

各ページ末に「アニメーション要素 ⇔ Go コード」の対応表:

| 画面上の表現 | Go コード |
|---|---|
| ノード枠の R/W バッジ | `frame.latch.RLock()/Lock()` |
| 下降時の強調エッジ | `internalFindChildIdx` の結果 |
| 要素の緑フラッシュ | `leafInsertAt` / `leafSetPair` |
| 要素の複製が親へ飛ぶ | 葉分裂のコピーアップ (`leafInsertSplit`) |
| 要素そのものが親へ移動 | 内部昇格/`internalBorrowFrom*` |
| 点線フェードのノード | `freePage` → フリーリスト |
| 祖先ラッチ一括解除 | `releaseHeld(&held)` |
| 全解放→操作最初から | `errRestart` → `retryOp` |
