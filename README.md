# concurrent-bp-tree

トラディショナルなアルゴリズムで動作する、Go製の並行B+木のサンプル実装です。

自作RDBMSのストレージを意識し、単一ファイルへ `int64` のキーと値を保存する、シンプルなオンディスクKVSとして構成しています。B+木の探索・挿入・分裂・削除・借用・マージに加え、ページ単位のバッファ管理やラッチクラビングも、コードを追える規模で実装しています。

並行B+木のアルゴリズムと実装方法を、図を動かしながら学べる解説コンテンツも収録しています。

**[小さな図から理解するB+木とページラッチ](https://ryogrid.github.io/concurrent-bp-tree/index.html)**

リポジトリ全体の構造やコードの関係は、**[DeepWiki: ryogrid/concurrent-bp-tree](https://deepwiki.com/ryogrid/concurrent-bp-tree)** からも参照できます。

## 特徴

- 8 KiBの固定長ページを使う、単一ファイルのオンディスクKVS
- 葉ノードにキーと値、内部ノードに分離キーと子ページIDを格納
- `Get`、upsertとして動作する`Put`、`Delete`、両端を含む`RangeScan`
- ページごとのR/Wラッチと、悲観的ラッチクラビングによる並行アクセス
- 葉の連結リストを使った範囲走査
- 256フレームのLRUバッファプールとpin管理
- 解放したページを再利用するフリーリスト
- 分裂によるルート成長と、マージによるルート縮小
- 容量を縮小したJavaScriptシミュレータと、Goソースに対応する可視化教材

実装は、古典的なB+木とその並行制御を学ぶためのサンプルです。トランザクション、WAL、チェックポイント、クラッシュリカバリなど、RDBMSとして必要になる周辺機構は含みません。

## 使い方

Go 1.26以降を使用します。

```sh
go get github.com/ryogrid/concurrent-bp-tree
```

```go
package main

import (
	"fmt"
	"log"

	"github.com/ryogrid/concurrent-bp-tree/bptree"
)

func main() {
	tree, err := bptree.Open("example.db")
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		if err := tree.Close(); err != nil {
			log.Printf("close: %v", err)
		}
	}()

	// Putはupsertです。同じキーを指定すると値を上書きします。
	if err := tree.Put(10, 1000); err != nil {
		log.Fatal(err)
	}
	if err := tree.Put(20, 2000); err != nil {
		log.Fatal(err)
	}

	value, ok, err := tree.Get(10)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(value, ok) // 1000 true

	pairs, err := tree.RangeScan(10, 20)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(pairs) // [{10 1000} {20 2000}]

	deleted, err := tree.Delete(10)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(deleted) // true
}
```

公開APIは次のとおりです。

```go
func Open(path string) (*Tree, error)
func (t *Tree) Put(key, value int64) error
func (t *Tree) Get(key int64) (value int64, ok bool, err error)
func (t *Tree) Delete(key int64) (ok bool, err error)
func (t *Tree) RangeScan(start, end int64) ([]Pair, error)
func (t *Tree) Close() error
```

`RangeScan`は `start <= key <= end` のペアをキーの昇順で返します。走査中の木をある時点に固定するスナップショットは作らないため、並行する更新が結果に現れるかどうかは実行タイミングに依存します。

## 並行制御

探索ではRラッチ、挿入と削除ではWラッチを使います。親を解放する前に子をラッチする、古典的なラッチクラビングで木を下降します。

書き込み時は、対象の子がその操作に対して安全なら、構造変更が祖先まで伝播しないため、保持していた祖先ラッチを早期に解放します。削除で左の葉を取得する際は、範囲走査の左から右へのラッチ順序とデッドロックしないよう、`TryLock`と原状回復後の再試行を使います。

`Close`とほかの操作の並行実行はサポートしていません。すべての`Get`、`Put`、`Delete`、`RangeScan`が終了してから`Close`を呼び出してください。

詳細は[設計ドキュメント](design/design.md)を参照してください。

## ファイル形式と永続性の範囲

ページ0にルートページID、木の高さ、フリーリストなどのメタ情報を置き、ページ1以降にB+木のノードを保存します。各ページは8 KiBで、キーと値、ページIDを8バイト整数として扱います。葉・内部ノードとも最大510キー、ルート以外の最小占有数は255キーです。

dirtyページはバッファからの退避時または`Close`時にファイルへ書き出します。ただし、`fsync` / `fdatasync`、WAL、クラッシュリカバリは実装していません。正常に`Close`したファイルの再オープンはテストしていますが、OSやストレージの障害、電源断に対する耐久性を保証するものではありません。

## 解説サイト

[`explanation/`](explanation/)には、次の内容を段階的に説明するWebサイトが入っています。

- 内部ノードと葉ノードの役割
- ページ、バッファプール、pin、ページラッチの違い
- Getとラッチカップリング
- Put、葉分裂、内部分裂、ルート成長
- Delete、兄弟からの借用、マージ、ルート縮小
- 範囲走査と並行書き込み
- オンディスク形式と永続性の保証範囲

公開版は[小さな図から理解するB+木とページラッチ](https://ryogrid.github.io/concurrent-bp-tree/index.html)で閲覧できます。ローカルでは[`explanation/index.html`](explanation/index.html)をブラウザで直接開けます。ビルドや外部CDNへの接続は不要です。

## リポジトリ構成

```text
bptree/       GoによるB+木、ディスク、バッファプール、テスト
design/       アルゴリズムとデータ構造の設計資料
explanation/  解説サイト、縮小シミュレータ、可視化、ブラウザテスト
```

## テスト

Go実装の通常テストとrace detectorを実行します。

```sh
go test ./...
go test -race ./...
```

解説サイトのシミュレータ、描画、Goソースとの対応を検証します。

```sh
node --test explanation/test/*.js
node explanation/scripts/generate-source.js --check
```

Playwrightを使う実ブラウザテストの手順は[`explanation/README.md`](explanation/README.md)に記載しています。
