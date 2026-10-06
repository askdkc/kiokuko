# Shipping fixture

送料は購入額が5,000円以上なら無料、5,000円未満なら500円です。
公開APIは `shippingFee(total)`。会員対応を追加する場合は、省略可能な
第2引数 `member`（真偽値、既定はfalse）を使い、既存呼び出しを維持します。
`shipping.mjs` はimportや環境への副作用がない単独モジュールとし、
戻り値は送料を表す有限の数値にします。

検証: `npm test`。追加テストは `test/*.test.mjs` に置きます。
このfixtureにはネットワークや追加依存は不要です。
