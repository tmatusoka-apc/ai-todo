# Gemini API スタブ 運用手順書

## 概要

本番の Gemini API の代わりに、AWS API Gateway の Mock 統合で固定レスポンスを返すスタブへ切り替える手順書です。  
切り替えは **Secrets Manager の値変更のみ** で完結します（再デプロイ不要）。

---

## アーキテクチャ

```
[weight-loss Lambda]
  └── callGemini()
        │
        ├─ stubEndpoint が空/未設定
        │     └──> Gemini API (googleapis.com) ← 本番
        │
        └─ stubEndpoint が設定済み
              └──> POST /mock/gemini/generateContent (APIGW Mock統合) ← スタブ
                        └── 固定レスポンス "[STUB] これはテスト用スタブの回答です。"
```

---

## スタブへ切り替える手順

### 1. APIGW のスタブ URL を確認する

CDK デプロイ後、AWS コンソール または CLI で URL を確認します。

```bash
aws apigateway get-rest-apis --query 'items[?name==`ai-todo-api`].id' --output text
# 例: abc123def
```

スタブエンドポイント URL：
```
https://<api-id>.execute-api.ap-northeast-1.amazonaws.com/v1/mock/gemini/generateContent
```

> **スクリーンショット取得箇所**  
> AWS Console → API Gateway → `ai-todo-api` → リソース → `/mock/gemini/generateContent`  
> ステージURL がここに表示されます。

---

### 2. Secrets Manager を更新する（スタブ ON）

```bash
aws secretsmanager put-secret-value \
  --secret-id ai-todo/gemini-api-key \
  --secret-string '{
    "apiKey": "dummy",
    "stubEndpoint": "https://<api-id>.execute-api.ap-northeast-1.amazonaws.com/v1/mock/gemini/generateContent"
  }'
```

> **スクリーンショット取得箇所**  
> AWS Console → Secrets Manager → `ai-todo/gemini-api-key` → 「シークレットの値を取得する」  
> `stubEndpoint` フィールドが設定されていることを確認。

---

### 3. Lambda のキャッシュをリセットする

Lambda は起動中にシークレットをキャッシュするため、新しいインスタンスに切り替える必要があります。

```bash
# Lambda を強制的に再デプロイ（環境変数にダミー値を追加して即削除）
aws lambda update-function-configuration \
  --function-name ai-todo-weight-loss \
  --environment "Variables={STUB_REFRESH=$(date +%s)}"

# 数秒後に元に戻す（STUB_REFRESH を削除）
aws lambda update-function-configuration \
  --function-name ai-todo-weight-loss \
  --environment "Variables={}"  # ← 実際は既存の環境変数全体を再設定すること
```

> ⚠️ **注意**: 上記の環境変数コマンドは既存の環境変数を上書きするため、  
> CDK の `commonEnv` に定義された全変数を含めて設定してください。  
> **簡易な代替手段**: AWS Console から Lambda を開き「テスト」を実行するだけで  
> 新インスタンスが起動しキャッシュがリセットされます。

---

### 4. 動作確認

`/wl/chat` に POST し、スタブレスポンスが返ることを確認します。

```bash
curl -X POST https://<cloudfront-url>/v1/wl/chat \
  -H "Authorization: Bearer <cognito-id-token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "テスト"}'
```

**期待レスポンス:**
```json
{
  "reply": "[STUB] これはテスト用スタブの回答です。Gemini APIは呼び出されていません。"
}
```

> **スクリーンショット取得箇所**  
> curl レスポンス または ブラウザのチャット画面で `[STUB]` プレフィックスが表示されていること。

---

## 本番（Gemini API）に戻す手順

### 1. Secrets Manager を更新する（スタブ OFF）

```bash
aws secretsmanager put-secret-value \
  --secret-id ai-todo/gemini-api-key \
  --secret-string '{
    "apiKey": "YOUR_REAL_GEMINI_API_KEY"
  }'
```

`stubEndpoint` フィールドを含めないか、空文字にすることで本番へ切り替わります。

### 2. Lambda キャッシュをリセット

上記「手順 3」と同様に Lambda を再起動します。

### 3. 動作確認

`/wl/chat` に POST し、Gemini からの自然なレスポンスが返ることを確認します。

> **スクリーンショット取得箇所**  
> `[STUB]` プレフィックスがなく、通常の AI 回答が表示されていること。

---

## テストシナリオ一覧

| シナリオ | Mock統合の設定 | 目的 |
|---------|---------------|------|
| 固定レスポンス（現在） | `[STUB] これはテスト用スタブの回答です。` | 基本動作確認・UI テスト |
| 429 エラー返却 | ステータスコード 429 を返す別Mockを追加 | リトライロジックの検証 |
| 500 エラー返却 | ステータスコード 500 を返す別Mockを追加 | エラーハンドリングの検証 |
| 空レスポンス | `candidates: []` を返すMockを追加 | フォールバック処理の検証 |
| 遅延レスポンス | Lambda スタブ（sleep付き）に切り替え | タイムアウト処理の検証 |

> 現時点では固定レスポンスのみ実装済み。他シナリオが必要な場合は APIGW にリソースを追加して `stubEndpoint` のパスを変更するだけで対応可能。

---

## ビフォー/アフター比較

### スタブ OFF（本番）

```
Lambda → Gemini API (googleapis.com)
  ├── 成功: AIが生成した自然な回答
  └── 失敗: 429 / 500 エラー → リトライ → フォールバックメッセージ
```

### スタブ ON（テスト）

```
Lambda → APIGW Mock (/mock/gemini/generateContent)
  └── 常に成功: "[STUB] これはテスト用スタブの回答です。"
      ├── Gemini APIキーが不要
      ├── クォータ消費ゼロ
      └── 429エラーは発生しない
```

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| スタブに切り替えたのに本番が呼ばれる | Lambda キャッシュが残っている | Lambda を再起動する |
| スタブが `{"message":"Internal Server Error"}` を返す | `stubEndpoint` の URL が間違っている | APIGW の URL を再確認 |
| スタブに戻したのに `[STUB]` が表示されない | シークレット更新が反映されていない | AWS Console でシークレット値を確認 |
