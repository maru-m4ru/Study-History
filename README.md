# TurboWarp Web Viewer (初期プロトタイプ)

TurboWarp のステージ上に iframe を重ね、Cloudflare Workers 経由で取得した Web ページを表示するプロトタイプです。

## ファイル

- `worker.js`: Cloudflare Workers のプロキシ
- `extension.js`: TurboWarp のサンドボックスなし拡張機能
- `wrangler.toml`: Wrangler の最小設定

## 1. Cloudflare Workers へデプロイ

1. Cloudflare ダッシュボードで Workers & Pages から Worker を作成するか、Wrangler を使います。
2. `worker.js` と `wrangler.toml` を同じディレクトリに配置します。
3. Wrangler を使う場合は `npx wrangler deploy` を実行します。
4. デプロイ先の `https://....workers.dev` を控えます。
5. `https://....workers.dev/health` を開き、`status: "ok"` が返ることを確認します。

## 2. 表示可能なドメインを設定

`worker.js` の `ALLOWED_HOSTS` に、表示したいサイトと必要な CDN ドメインを追加します。初期状態は `example.com` のみです。

```js
const ALLOWED_HOSTS = [
  "example.com",
  "example.org",
];
```

ドメインは完全一致またはサブドメイン一致で許可されます。たとえば `example.org` は `www.example.org` にも適用されます。無制限の公開プロキシにならないよう、必要なドメインだけを登録してください。

## 3. TurboWarp 拡張機能を設定

`extension.js` の `WORKER_BASE` を実際の Worker URL に変更します。

```js
const WORKER_BASE = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev';
```

TurboWarp の拡張機能メニューから拡張機能を読み込み、`extension.js` を選んで **「サンドボックスなしで実行」** を有効にします。読み込み方法は TurboWarp のバージョンによって表示が多少異なる場合があります。

## ブロック

- `Webサイト [URL] を表示する`
- `表示領域を 幅 [WIDTH] 高さ [HEIGHT] にする`
- `Webサイト表示を閉じる`
- `表示中のWebサイトURL`
- `Webサイト表示の状態`

## この版の制限

- まずは表示を目的とした読み取り専用プロトタイプです。プロキシは `GET` / `HEAD` のみで、フォームの `POST`、ログイン、Cookie、認証が必要なサイトは想定していません。
- `ALLOWED_HOSTS` にない外部リソースはプロキシされません。画像・CSS・JavaScript などが別ドメインから配信されている場合は、その CDN のドメインを追加する必要がある場合があります。
- CSS と一般的な HTML 属性の URL は書き換えますが、JavaScript が内部で生成する絶対URL、複雑な認証・SPA・ストリーミングなど、すべての Web サイトに対応する完全なブラウザーではありません。
- Worker のホストに同意なくアクセスしたり、サイト側の利用規約やアクセス制御に反して使用したりしないでください。
- Worker のドメインを追加の信頼境界として使わないでください。この拡張機能は任意のサイトのコンテンツを表示するため、サンドボックスなし拡張機能を信頼できるプロジェクトでのみ使用してください。
