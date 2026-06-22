# 減量特化サービス 基本設計書

## 1. システムアーキテクチャ

```
[ユーザー (ブラウザ)]
        |
        | HTTPS
        v
[Amazon CloudFront]
   |          |
   | /v1/*    | /* (SPA)
   v          v
[API Gateway] [S3 Bucket]
   |           weight-loss.html
   | Lambda    index.html
   | Proxy     admin-analysis.html
   v
[Lambda: ai-todo-weight-loss]
   |
   |-- DynamoDB: ai-todo-wl-weight-logs
   |-- DynamoDB: ai-todo-wl-knowledge
   |-- DynamoDB: ai-todo-wl-todos
   |-- DynamoDB: ai-todo-users (身長取得用)
   |-- Secrets Manager: ai-todo/gemini-api-key
   |
   v (RAGチャット時)
[Google Gemini API]
   https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent

[Amazon Cognito]
  - 認証: Hosted UI
  - JWT検証: API Gateway Cognito Authorizer
```

---

## 2. DynamoDB テーブル設計

### 2.1 ai-todo-wl-weight-logs（体重ログ）

| 属性名 | 型 | 説明 |
|--------|-----|------|
| userId | S (PK) | Cognito sub（ユーザーID） |
| date | S (SK) | 記録日（YYYY-MM-DD） |
| weight | N | 体重（kg） |
| bmi | N | BMI（自動計算。身長未設定時はnull） |
| memo | S | メモ（任意） |
| createdAt | S | 作成日時（ISO8601） |

- BillingMode: PAY_PER_REQUEST
- PointInTimeRecovery: true
- RemovalPolicy: RETAIN

### 2.2 ai-todo-wl-knowledge（ナレッジベース）

| 属性名 | 型 | 説明 |
|--------|-----|------|
| userId | S (PK) | Cognito sub（ユーザーID） |
| knowledgeId | S (SK) | ナレッジID（timestamp-uuid） |
| title | S | タイトル |
| content | S | 本文 |
| tags | SS | タグリスト（String Set） |
| createdAt | S | 作成日時（ISO8601） |
| updatedAt | S | 更新日時（ISO8601） |

- BillingMode: PAY_PER_REQUEST
- PointInTimeRecovery: true
- RemovalPolicy: RETAIN

### 2.3 ai-todo-wl-todos（減量ToDo）

| 属性名 | 型 | 説明 |
|--------|-----|------|
| userId | S (PK) | Cognito sub（ユーザーID） |
| todoId | S (SK) | ToDoID（timestamp-uuid） |
| title | S | タスクタイトル |
| category | S | カテゴリ（運動/食事/習慣） |
| completed | BOOL | 完了フラグ |
| date | S | 対象日（YYYY-MM-DD） |
| createdAt | S | 作成日時（ISO8601） |

- BillingMode: PAY_PER_REQUEST
- PointInTimeRecovery: true
- RemovalPolicy: RETAIN
- LSI: DateIndex（PK=userId, SK=date）

---

## 3. API エンドポイント一覧

全エンドポイントは Cognito 認証必須（Authorization: Bearer {idToken}）

| メソッド | パス | 説明 |
|----------|------|------|
| GET | /v1/wl/dashboard | ダッシュボード情報取得 |
| GET | /v1/wl/profile | プロフィール取得（目標体重・目標期日など） |
| PUT | /v1/wl/profile | プロフィール更新（目標体重・目標期日など） |
| GET | /v1/wl/weight-logs | 体重ログ一覧（?limit=30） |
| POST | /v1/wl/weight-logs | 体重ログ追加 |
| DELETE | /v1/wl/weight-logs/{date} | 体重ログ削除（日付指定） |
| GET | /v1/wl/todos | ToDo一覧（?date=YYYY-MM-DD） |
| POST | /v1/wl/todos | ToDo作成（isTemplate: trueでスターターキット） |
| PUT | /v1/wl/todos/{todoId} | ToDo更新（完了トグルなど） |
| DELETE | /v1/wl/todos/{todoId} | ToDo削除 |
| GET | /v1/wl/knowledge | ナレッジ一覧 |
| POST | /v1/wl/knowledge | ナレッジ追加 |
| PUT | /v1/wl/knowledge/{knowledgeId} | ナレッジ更新 |
| DELETE | /v1/wl/knowledge/{knowledgeId} | ナレッジ削除 |
| POST | /v1/wl/chat | AIチャット（RAG） |

---

## 4. Lambda 関数一覧

| 関数名 | ファイル | timeout | memorySize | 説明 |
|--------|---------|---------|-----------|------|
| ai-todo-weight-loss | lambda/weight-loss/handler.ts | 60s | 512MB | 減量機能全般 |

---

## 5. 画面遷移

```
[ブラウザアクセス]
        |
        v
[プロフィール未設定?]
        |
     YES|          NO
        v           v
[プロフィール設定モーダル]    |
   - 身長入力                |
   - 目標体重入力             |
   - 目標期間入力             |
   - LocalStorageに保存       |
        |                    |
        v                    v
     [ダッシュボードタブ (デフォルト)]
           |
    [タブナビゲーション]
           |
   +-------+-------+--------+--------+
   |       |       |        |        |
   v       v       v        v        v
[体重ログ] [ToDo] [ナレッジ] [チャット]
```

### 5.1 ダッシュボードタブ
- 目標体重・現在体重・達成率表示
- ストリーク（連続記録日数）
- 今日のToDo進捗プログレスバー
- 体重グラフ（Canvas折れ線グラフ）

### 5.2 体重ログタブ
- 日付・体重入力フォーム
- 記録一覧テーブル
- グラフ表示

### 5.3 ToDoタブ
- スターターキットボタン（初回のみ）
- カテゴリフィルタ（全て/運動/食事/習慣）
- タスクチェックリスト
- タスク追加フォーム

### 5.4 ナレッジベースタブ
- タイトル・本文・タグ入力フォーム
- タグサジェスト
- 検索フィルタ
- カード一覧

### 5.5 AIチャットタブ
- 吹き出し形式チャットUI
- メッセージ入力・送信
- AIが考え中アニメーション
