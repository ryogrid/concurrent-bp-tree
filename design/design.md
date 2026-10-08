# 並行 B+ Tree オンディスク KVS ライブラリ 詳細設計書

## 1. 目的と要件

Go 言語で、オンディスク B+ tree をベースにした KVS ライブラリを実装し、
さらにそのアルゴリズム（データ構造と排他制御）とコードの対応関係を日本語で解説する
アニメーション付き HTML5 ファイルを作成する。

### 要件整理

| # | 要件 | 設計上の決定 |
|---|------|--------------|
| 1 | 古典的なアルゴリズム | 教科書的 B+ tree + 悲観的ラッチクラビング（latch crabbing / lock coupling） |
| 2 | key, value は int64 のみ | ページ内データは int64 配列として扱う |
| 3 | DB ファイルは単一、WAL なし、適宜伸長 | `os.File` + `ReadAt`/`WriteAt`。新規ページ割当時にファイル末尾へ伸長 |
| 4 | x64 Linux のみ | `encoding/binary` でリトルエンディアン固定（x64 前提だが明示する） |
| 5 | 木の最大高さ K は定数 | `MaxTreeHeight = 8`（下降パスのスタック確保用） |
| 6 | バッファプールのフレーム数は定数 | `BufferPoolFrames = 256` |
| 7 | ページサイズ 8kB | `PageSize = 8192` |
| 8 | 複数 goroutine で並列操作可 | ページ単位 R/W ラッチによる latch crabbing |
| 9 | Put / Get / Delete / RangeScan（昇順）をアトミックに | 各操作が latching protocol に従い線形化可能 |
| 10 | ノード間接続はファイル永続化、オンメモリポインタ走査禁止 | ノード間参照は全て pageID (int64)。走査は必ずページフェッチ経由 |
| 11 | split / merge によるバランシング | 古典的な再分配（borrow）+ マージ。ルートの成長/縮小も対応 |
| 12 | fsync / fdatasync 不要 | dirty ページの書き戻しのみ。`Close` 時に全 dirty を flush |
| 13 | 木全体をロックしない | ノード（ページ）単位ラッチ。メタ情報も専用の短命ラッチ |

## 2. ディスクフォーマット

### 2.1 ファイル構成

- ファイルは固定長 8kB ページの配列。ページ i のオフセットは `i * 8192`。
- ページ 0 は **メタページ**。ページ 1 以降が B+ tree のノードページ。
- 新規ページは「フリーリストからの再利用」→「なければファイル末尾を伸長」の順で割当。

### 2.2 ページは int64 配列

全ページを `[1024]int64`（`encoding/binary` の LittleEndian でエンコード）として
解釈する。key, value, pageID, ヘッダフィールドを全て int64 に統一することで、
フォーマットとコードの対応が一目で分かる教材的構造にする。

### 2.3 メタページ（pageID = 0）

| index | 内容 |
|-------|------|
| 0 | マジック定数 `0xC0B17EEE`（初期化済み判定用） |
| 1 | フォーマットバージョン = 1 |
| 2 | ルートページの pageID |
| 3 | 木の高さ（リーフのみ=1） |
| 4 | フリーリスト先頭 pageID（0=空） |
| 5 | 次に未使用の pageID（= ファイルサイズ/8192） |

### 2.4 内部ノード（page type = 1）

```
idx:  0      1        2       3      4       5      6
    +------+-------+-------+------+-------+------+----- ...
    |type=1| nKeys | child0| key0 | child1| key1 | ...
    +------+-------+-------+------+-------+------+-----
```

- `child[i]` は index `2+2i`、`key[i]` は index `3+2i`（i = 0..nKeys-1、child は nKeys+1 個）
- 不変条件: `child[i]` の部分木のキー < `key[i]` ≤ `child[i+1]` の部分木のキー
- `MaxInternalKeys = 510`（最大 511 children）、`MinInternalKeys = 255`

### 2.5 リーフノード（page type = 2）

```
idx:  0      1        2            3      4      5      6
    +------+-------+------------+------+------+------+----- ...
    |type=2| nPairs| nextLeafPID| key0 | val0 | key1 | val1 |
    +------+-------+------------+------+------+------+------
```

- `key[i]` は index `3+2i`、`val[i]` は index `4+2i`
- `nextLeafPID` は右兄弟（RangeScan 用の水平リンク。0=右端）
- `MaxLeafPairs = 510`、`MinLeafPairs = 255`

### 2.6 フリーリスト

- 解放されたページは page[0] に次の空き pageID を書き込み、単方向リスト化。
- 先頭はメタページ index 4。push/pop は `metaMu` で直列化。

## 3. パッケージ構成

```
module github.com/ryogrid/concurrent-bp-tree-tutrial

bptree/
  const.go     — PageSize / BufferPoolFrames / MaxTreeHeight / 容量定数 / エラー
  meta.go      — Meta 構造体とメタページのエンコード/デコード
  disk.go      — DiskManager（ReadPage/WritePage/ページ割当/Close）
  freelist.go  — フリーリスト push/pop
  buffer.go    — BufferPool / Frame（ページテーブル, pin, dirty, LRU エビクション）
  node.go      — ノードページの読み書きプリミティブ（キー検索, 挿入, 分割ヘルパ等）
  tree.go      — Tree: Open/Close/Put/Get/Delete/RangeScan + latch crabbing
  *_test.go    — 各種テスト
design/
  design.md    — 本ドキュメント
  TODO.md      — 進捗管理
explanation/
  index.html   — アニメーション付き解説ページ（単一ファイル, vanilla JS+SVG）
```

## 4. コンポーネント設計

### 4.1 DiskManager

```go
type DiskManager struct{ f *os.File; path string }
func (d *DiskManager) ReadPage(pid PageID, dst []byte) error   // ReadAt(pid*8192)
func (d *DiskManager) WritePage(pid PageID, src []byte) error  // WriteAt(pid*8192)
func (d *DiskManager) Close() error
```

- `ReadAt`/`WriteAt` は同一ファイルでの並行呼出し安全。末尾を越えた WriteAt でファイルが伸長。
- fsync 系は呼ばない（要件12）。

### 4.2 BufferPool

```go
type Frame struct {
    pageID   PageID
    dirty    bool
    pin      int          // pool.mu 配下で管理
    lastUsed uint64       // LRU 判定用 tick
    latch    sync.RWMutex // ページの論理ラッチ
    data     [PageSize]byte
}
type BufferPool struct {
    mu     sync.Mutex
    disk   *DiskManager
    frames [BufferPoolFrames]Frame
    table  map[PageID]int // pageID → frame index
    tick   uint64
}
```

- `Fetch(pid)` : ヒット→pin++。ミス→ victim 選択（pin==0 の中で lastUsed 最小＝LRU。線形スキャン256回で十分）→ dirty なら WritePage → ReadPage → table 登録 → pin=1。
- `Unpin(f, dirty)` : pin--、dirty フラグ OR。
- `FlushAll()` : 全 dirty フレームを WritePage（Close 時）。
- victim が無い（全フレーム pin 中）→ `ErrNoFreeFrame`。高さ≤8 なので 1 操作の同時 pin はせいぜい 10 前後。256 フレームで実用上枯渇しない。
- **フレーム枯渇デッドロック対策（レビュー指摘反映）**: 構造変更伝播中の `allocPage`/`fetch` は中断できないため、無限リトライを「他 op がフレームを解放する」前提で行う。この前提を保証するため、公開 API 入口でセマフォ（`opSlots`, 上限 `maxConcurrentOps = 20`）を取る。実行中 op の最大同時 pin ≈ 20×(K+3) ≈ 220 < 256 となり、セマフォ待ちの op は何も保持しないため、デッドロック巡回が成立しない。
- **pin とラッチの不変条件**: ラッチを保持している間、そのフレームは必ず pin 済み。これにより victim は絶対にラッチ保持中のフレームにならない（pin>0 ⇒ エビクション対象外）。
- `pool.mu` はフレームの pin/table 更新のみを守る短命ミューテックス。`pool.mu` 保持中にページラッチは取得しない（ロック順序: ページラッチ > pool.mu）。

### 4.3 メタ情報と専用ラッチ

`Tree` がメタ情報をオンメモリに保持し、2 つのラッチで守る:

```go
type Tree struct {
    disk   *DiskManager
    pool   *BufferPool
    meta   Meta
    rootMu sync.RWMutex // meta.rootPageID と meta.height を守る
    metaMu sync.Mutex   // meta.freeListHead と meta.nextPageID を守る
}
```

- `rootMu` は「ルートがどのページか」の保護専用で、取得は操作冒頭の一瞬（ルートが unsafe な場合のみ操作終了まで保持=ルート分裂/縮小の直列化）。**木全体のロックではない**。
- `metaMu` はフリーリスト push/pop と新規 pageID 採番のみを守る短命ミューテックス。
- メタページへの書き戻しは `writeMeta()` が行う。**呼び出し規約: `rootMu` も `metaMu` も保持していないコンテキストからのみ呼ぶ**。内部で `rootMu.RLock` → `metaMu.Lock` の順に取得してスナップショットをエンコードし、両方解放後に pool 経由で page 0 を dirty 化する。これにより `rootMu→metaMu` の順序が常に維持される。呼び出し箇所は (a) `Open`/`Close`、(b) `metaMu` を保持していない操作終了時、および (c) ルート構造変更操作が `rootMu` を解放した直後。メタの実行時の正本は `Tree.meta` のインメモリ値であり、メタページは永続化スナップショットに過ぎないため、`Close` までの中間書き戻しは省略しても再オープン正規パスに影響しない（fsync 不要要件の範囲内）。
- **ロック順序（デッドロック回避規則）**: `rootMu` → `metaMu`、およびページラッチは「上→下、兄弟は左→右」、`pool.mu` は最内側のリーフロック。
  - **注意（レビュー指摘反映）**: 実際には split/merge 中に「ページ W ラッチ保持したまま `metaMu` を取得」する経路がある（ページ割当・フリーリスト push）。つまり `metaMu` はページラッチ階層に対するリーフロックであり、**`metaMu` のクリティカルセクション内ではページラッチも `rootMu` も取得しない**ことが不変条件。これにより巡回は発生しない。
  - `pool.mu` 保持中にページラッチは取得しない。metaMu 保持中に `pool.mu`（Fetch 経由）を取ることは可。
  - 左兄弟のラッチが必要な時だけ `TryLock` を使い、失敗したら全ラッチ解放して操作を最初からやり直す（§5.3 参照）。

### 4.4 ノード操作プリミティブ（node.go）

ページバイト列に対する操作。フレームの `data` を int64 配列として index アクセス:

- `nodeType`, `keyCount` 等の getter/setter
- `leafFind(key) (index, found)` / `internalFindChild(key) PageID`（二分探索）
- `leafInsert`, `leafDelete`, `internalInsert(key, child)`, `internalDelete(idx)`
- `splitInHalf` 系のヘルパ（5.2 参照）
- **オーバーフローの扱い（重要）**: オーバーフロー状態（リーフ 511 ペア、内部 511 キー）は 8kB ページに収まらない（index 1024 が必要になる）。そのため「ページに挿入してから split」はせず、**スクラッチ配列**（容量 Max+1 エントリの `[]int64` 一時バッファ）に既存内容+新規エントリをソート済みで構築し、そのスクラッチを 2 ページに分配して書き戻す方式とする。`node.go` に `leafSplitScratch` / `internalSplitScratch` 相当のヘルパを用意する。

## 5. アルゴリズム設計（latch crabbing）

全操作は「下降フェーズでラッチを crab（蟹歩き）し、構造変更はラッチ済み祖先へ伝播」する
古典的悲観プロトコル（CMU 15-445 / Ramakrishnan&Gehrke 流）。

### 5.1 Get

```
rootMu.RLock(); pid := meta.root
f := pool.Fetch(pid); f.RLock(); rootMu.RUnlock()
for f が内部ノード:
    child := internalFindChild(key)
    cf := pool.Fetch(child); cf.RLock()
    f.RUnlock(); f = cf            // crab: 子を取ってから親を放す
leaf 内を二分探索 → (value, ok)
```

### 5.2 Put

```
rootMu.Lock()                       // ルート張替え保護
root := Fetch(meta.root); root.Lock()
if root.isSafeForInsert()           // nKeys < Max
    rootMu.Unlock()                 // 以降 root は変わらない → 早期解放
ancestors = [root]
下降: 各レベルで子を WLatch。子が safe なら ancestors の全ラッチ解放。
   unsafe なら latched stack に残す（祖先ラッチは保持し続ける）。
leaf に upsert。
leaf オーバーフロー時:
    新規ページ割当 → leaf を split（右側に新ノード, nextLeafPID 接続）
    分離キー(新右ノードの最小キー)と新 pageID を親へ挿入。
    親も溢れれば再帰的に split。祖先は全て WLatch 済みなので安全に遡れる。
ルート自体が split → 新ルートページ生成, meta.root/height 更新（rootMu 保持中）。
最後に rootMu.Unlock()（保持していた場合）。
```

- **safe for insert**: `keyCount < MaxKeys`（このノードは split を伝播しない）。
- リーフ分裂: スクラッチ上の n+1=511 ペアを左 255 / 右 256 に分割（分離キーは右ノードの最小キー＝copy-up）。内部ノード分裂: スクラッチ上の 511 キーを中央キー `key[255]` で分け、左 255 キー+子 256、右 255 キー+子 256 とする。`key[255]` 自体は親へ **promote（移動）** し、**右ノードの先頭子は promote されたキーの右側にあった子（旧 `child[256]`）**。内部ノードではキーは copy ではなく移動する点に注意。
- 兄弟リンク: 新右ノード `next = old.next`; `old.next = 新右`。

### 5.3 Delete

Put と同じ W クラビングで下降。**safe for delete**: `keyCount > MinKeys`
（このノードから 1 減ってもアンダーフローしない）。リーフで削除後:

- `nPairs >= Min` → 終了
- アンダーフロー → 兄弟処理:
  1. **右兄弟から借用**（右 sibling は左→右順で WLatch 可）: 右が Min+1 以上なら最小要素を移す。親の分離キー更新。左兄弟からの借用も同様に可能だが、左 sibling の WLatch は `TryLock` で取得し、失敗時は再試行（下記マージと同じ規則）。
  2. **マージ**（兄弟から借りられない場合）:
     - 自分が左端（右兄弟のみ存在）→ 右ノードを自分に吸収（`merge right into self`）。右 sibling の WLatch は左→右順で取得可。
     - 左兄弟がある → 自分を左兄弟に吸収（`merge self into left`）。左 sibling の WLatch は **ロック順序違反**（保持中のノードより左を取る）になり得るため `TryLock` で取得。失敗時は全ラッチ解放して操作を最初から再試行。
     - **内部ノードのマージでは、親の分離キーをマージ後ノードへ「引き下ろす」**（`254 + 1 + 255 = 510 ≤ MaxInternalKeys` の +1 がこのキー）。リーフのマージでは分離キーは移さず親から削除するだけ。
     - **リーフマージでは残ったノードの `nextLeafPID` を、消えるノードの `nextLeafPID` で更新**し、水平リンクから外す。
  3. マージ後、親から分離キーと子ポインタを削除 → 親がアンダーフローすれば同様に上へ伝播。親が Min 以上に留まればそこで終了。
  4. 空きページは「ラッチ解放・pin 解除を先に済ませてから」フリーリストへ push（metaMu）。ラッチ保持中のページがフリーリストに見える状態を作らない。
- ルートが内部ノードで 0 キー（1 子）になった → `meta.root = 唯一の子`, `height--`。ルートがリーフで空 → 空木のまま維持（height=1）。
- **残留アンダーフロー（lazy rebalance）**: 上方向のマージ途中で `TryLock` 失敗により再起動した場合、下位でコミット済みのマージは残り、中間の内部ノードが Min 未満のまま残り得る。これはバランス不変条件の違反のみで、探索・挿入・スキャンの正当性には影響しない。同一経路の後続 Delete が遅延的に修復する。退化した「子を 1 つだけ持つ内部ノード」も許容し、そのノードを親が指す側では兄弟処理をスキップして上位へ伝播する。

### 5.4 RangeScan(start, end) ([]Pair, error)

```
Get と同じ R クラビングで start の属するリーフへ
そのリーフ内で key ∈ [start,end] のペアを収集
leaf 末尾に達したら nextLeafPID を読み、次リーフを RLatch してから現リーフ解放
   （水平方向の crab。分裂中でも WLatch がブロックするため破断しない）
key > end になった時点で終了。結果を []Pair で返す
```

- 区間は両端 inclusive。`start > end` なら空スライス。
- スキャン中の並行 Put/Delete で同一キーが 2 度出たり分裂直後のキーを見落としたりしないのは「次リーフ確保まで現リーフを離さない」カップリングによる。
- RangeScan はカーソル一貫性であってポイントインタイムのスナップショットではない：スキャン位置より前方への同時挿入は結果に現れ得る（逆に削除で未収集キーが消えることもあり得る）。これは要件の「アトミックに実行できる」の範囲内（操作自体の中断・破断が起きない）と整理する。

### 5.5 アトミシティとデッドロックフリー性

- 各操作は対象キー経路上のページを latching protocol に従って排他するため、同じキーへの操作は必ずリーフ W ラッチで直列化 → 操作単位でアトミック。
- ラッチ取得順序を「親→子」「左→右」「rootMu→metaMu」とし、ページラッチ保持中の metaMu 取得は許容するが metaMu 保持中のページラッチ取得は禁止、`pool.mu` は常に最内側、と全操作で統一。唯一の例外となる左兄弟取得は TryLock+リトライで巡回を断つ → デッドロックなし。
- **エラー/中断時の万能解放規則**: `ErrNoFreeFrame`・IO エラー・`TryLock` 失敗等、操作中のどのポイントで失敗しても、**保持している全ラッチ・全 pin・`rootMu` を必ず解放してから** return またはリトライする。実装では「解放用スタック」を `defer` で一括解放する形を取り、ラッチの取りこぼしを構造的に防ぐ。
- 解放順序は「ラッチ Unlock → `Unpin`」とする（逆にすると unpin 済みフレームがエビクト・再利用され、ラッチだけ残る不整合になる）。

## 6. 公開 API

```go
package bptree

type PageID int64
type Pair struct{ Key, Value int64 }

func Open(path string) (*Tree, error)
func (t *Tree) Close() error                          // dirty flush + file close
func (t *Tree) Put(key, value int64) error            // upsert
func (t *Tree) Get(key int64) (value int64, ok bool, err error)
func (t *Tree) Delete(key int64) (ok bool, err error)
func (t *Tree) RangeScan(start, end int64) ([]Pair, error)
var ErrNoFreeFrame = errors.New(...)
var ErrMaxTreeHeight = errors.New(...)   // 高さが MaxTreeHeight を超えようとした場合（実用上不可到達）
var ErrCorruptFile   = errors.New(...)   // マジック不一致・不正フォーマット等
```

- `Open` : ファイルが存在しない/サイズ 0 なら初期化（メタページ + 空リーフルート）。非 0 ならメタ読込（マジック・バージョン・サイズの 8kB 倍数検証）し、不正なら `ErrCorruptFile`。
- `Close` : 全 dirty ページ書き戻し → メタページ書き戻し → file close。WAL/チェックポイント機構なし。**Close を操作中の Put/Get/Delete/RangeScan と並行呼出しすることは想定しない**（呼び出し側責任）。

## 7. テスト方針

| テスト | 内容 |
|--------|------|
| disk_test.go | ページ R/W 往復、ファイル伸長、フリーリスト push/pop |
| buffer_test.go | fetch/pin/unpin、dirty 書き戻し、256 超フェッチでエビクション、pin 中フレームは victim にならない |
| node_test.go | エンコード/デコード、二分探索、ソート挿入、split ヘルパ |
| tree_test.go | ランダム Put/Get vs `map[int64]int64` オラクル、split 多発（数千キー）、削除マージ、Delete 不存在、再 Open 永続化、RangeScan 境界/空区間 |
| concurrent_test.go | 8〜16 goroutine で Put/Get/Delete/Scan 混合。`go test -race`。終了後に全キー検証。ページ数が 256 を超える規模（≈10万キー級）でエビクションも並行発火 |

## 8. 解説 HTML（explanation/index.html）設計

- **単一の自己完結 HTML**。外部 CDN 依存を避け vanilla JS + inline SVG + CSS で実装（要件上ライブラリ使用可だが、オフライン確実性を優先）。
- 左サイドナビ + 各節は「SVG アニメーション領域」「ステップ説明文」「対応 Go コードパネル（該当行ハイライト）」の 3 カラム構成。
- 節構成:
  1. ファイルフォーマット（ページ配列/メタページ ↔ `const.go`,`meta.go`）
  2. ノードデータ構造（内部/リーフレイアウト図 ↔ `node.go`）
  3. Get：ルート→リーフ下降アニメーション ↔ `tree.go Get`
  4. Put + リーフ/内部スプリット ↔ `Put`, split 関数群
  5. Delete + 借用/マージ ↔ `Delete`, merge/redistribute 関数群
  6. ラッチクラビング：2 goroutine の W/R ラッチ時系列アニメーション ↔ latching protocol 実装
  7. バッファプール：fetch/エビクション/dirty 書き戻し ↔ `buffer.go`
  8. RangeScan：リーフ水平走査 ↔ `RangeScan`
- 各アニメーションはステップ送り（◀ ▶ + 自動再生）で、各ステップに「何が起きるか」の日本語説明と「対応コード行」のハイライトを同期表示。

## 9. 実施計画（design/TODO.md と対応）

各タスク: 実装 → `gofmt -l .` / `go vet ./...` / `go test ./... -race` → **swe モデルの reviewer サブエージェントに差分レビュー依頼** → 指摘対応 → commit & push → TODO.md にチェック。

1. 設計ドキュメント作成・レビュー・コミット（本ステップ）
2. 基盤: 定数・メタページ・DiskManager・フリーリスト + テスト
3. バッファプール + テスト
4. ノードレイアウト/プリミティブ + テスト
5. Get・Put（split・ルート成長）+ テスト
6. Delete（借用/マージ・ルート縮小）+ テスト
7. RangeScan + テスト
8. 並行・永続化ストレステスト（-race）
9. explanation/index.html 作成・レビュー・コミット

## 10. 設計上の判断メモ（却下した代替案）

- **楽観的クラビング（R 下降→必要時 W 取り直し）**: 実装は複雑。教材として悲観的が直感的で古典的。
- **B-link tree（右リンク+右下がり検索）**: 「古典的」要件には合うが latch crabbing より複雑で、水平リンクの説明も重複するため不採用。
- **左 sibling の WLatch を順序無視で取得**: スキャンの左→右カップリングとデッドロックし得るため TryLock+リトライを採用。
- **親ポインタをページに永続化**: 下降スタックで代替可能で、分裂時の全子ポインタ更新コストを避けるため不採用。
- **RangeScan をイテレータ化**: スライス一括返却が最も単純でアトミック性も明確。巨大レンジは今回の要件外。
