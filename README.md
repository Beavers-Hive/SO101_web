# SO101 Teleoperation Console

SO-101向けのブラウザ版テレオペレーションUIです。参考サイトの構成をベースに、Web Serial接続、カメラプレビュー、ルーム表示、アームノード管理、ジョイント操作、モーターテストを1つのVite + Reactアプリにまとめています。

Web Serial接続はFeetech Protocol 0のバイナリパケットを直接送信します。

## 起動

```bash
npm install
npm run dev -- --port 5173
```

ブラウザで `http://localhost:5173/` を開きます。Web Serial APIを使う場合はChromeまたはEdgeのデスクトップ版でアクセスしてください。

## ビルド

```bash
npm run build
```

## GitHub Pages

このアプリは静的サイトとしてGitHub Pagesへデプロイできます。Web Serial APIはセキュアコンテキストが必要なため、`https://<user>.github.io/...` で開いてください。

`webapp`ディレクトリの中身をリポジトリルートとしてpushしたあと、GitHub側で `Settings` → `Pages` → `Build and deployment` を `GitHub Actions` にすると、`.github/workflows/deploy-pages.yml` が `dist` を公開します。

注意:

- Web Serial APIはChromeまたはEdgeのデスクトップ版で使います。
- iOS SafariやFirefoxではSO101接続はできません。
- ロボット接続時はUSBシリアルポートをブラウザの許可ダイアログで選択してください。

## シリアル制御

設定値:

```txt
baudRate: 1000000
protocol: Feetech Protocol 0
motor IDs: 1, 2, 3, 4, 5, 6
```

主要レジスタ:

```txt
40 torque enable
42 goal position
56 present position
62 present voltage
```

テレオペレーション画面の `Enable` をONにすると検出済みモーターのトルクをONにします。`Stop` または `Enable` OFFでトルクをOFFにします。
