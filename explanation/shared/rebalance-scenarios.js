(function (g) {
  g.rebalanceScenarios = [
    {limit:800, remove:0, key:10, height:4, caption:"80キー・高さ4。10を削除すると葉と内部ノード2段でマージします。ルートにはまだ複数の子が残り、高さ4を保ちます。"},
    {limit:400, remove:0, key:10, height:3, caption:"40キー・高さ4。10の削除による不足がルートまで届き、子が1つになったルートを取り除いて高さ3になります。"},
    {limit:800, remove:360, key:370, height:4, caption:"80キーから10〜360を削除した高さ4の木。370を削除すると、葉とその親でマージした後、上の内部ノードが右兄弟から借用して不足を解消します。"},
  ].map(c => ({...c, autoSource:true, operation:"delete", overview:true,
    caption0:c.caption,
    prep(s) {for(let k=10;k<=c.limit;k+=10)s.put(k,k*100);for(let k=10;k<=c.remove;k+=10)s.del(k);},
    ops:[s=>s.del(c.key)],
  }));
})(globalThis);
