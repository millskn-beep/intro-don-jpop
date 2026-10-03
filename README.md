# アニソンイントロ対戦

ブラウザで遊べる、アニソンのイントロクイズ対戦ゲームです（オリジナル実装）。
同じ部屋に入った人に同じ曲のイントロが流れ、選択肢または曲名入力で回答を競います。

- 音源は YouTube 公式プレーヤーで再生します（音源の配信はしていません）。
- 曲データ（曲名・作品名・YouTube ID・秒数・読みがな）は `data/songs.json`。
- 背景やアイコンの画像は、ローカルの画像生成（FLUX.2）で作ったオリジナルです。

## 起動

```
npm install
npm start
```

http://localhost:3000 を開きます。曲チェック画面は http://localhost:3000/check.html 。

## 曲データの更新

- `data/catalog/*.csv` に曲を追加 → `node tools/import-catalog.js`
- 読みがな・略称 → `data/readings.json` を編集 → `node tools/apply-readings.js`
- サビ秒・別名・再生チェック → 曲チェック画面で編集して保存

公開サーバーで曲チェック画面から保存するには、環境変数 `ADMIN_KEY` を設定し、同じキーを `x-admin-key` ヘッダーで送る必要があります。
ただし公開サーバー（Render 無料プラン）のファイルは再デプロイで元に戻るため、曲データの編集は手元で行い、GitHub に反映してください。
