# 減量特化サービス 詳細設計書

## 1. DynamoDB テーブル詳細

### 1.1 ai-todo-wl-weight-logs

```
TableName: ai-todo-wl-weight-logs
KeySchema:
  - AttributeName: userId   (HASH)
  - AttributeName: date     (RANGE)
AttributeDefinitions:
  - AttributeName: userId   Type: S
  - AttributeName: date     Type: S
BillingMode: PAY_PER_REQUEST
PointInTimeRecoveryEnabled: true
DeletionProtectionEnabled: true (RemovalPolicy.RETAIN)

Item Example:
{
  "userId":    "abc123-uuid",
  "date":      "2026-05-28",
  "weight":    72.5,
  "bmi":       23.6,
  "memo":      "朝食後に計測",
  "createdAt": "2026-05-28T07:30:00.000Z"
}
```

### 1.2 ai-todo-wl-knowledge

```
TableName: ai-todo-wl-knowledge
KeySchema:
  - AttributeName: userId      (HASH)
  - AttributeName: knowledgeId (RANGE)
AttributeDefinitions:
  - AttributeName: userId      Type: S
  - AttributeName: knowledgeId Type: S
BillingMode: PAY_PER_REQUEST
PointInTimeRecoveryEnabled: true
DeletionProtectionEnabled: true (RemovalPolicy.RETAIN)

Item Example:
{
  "userId":      "abc123-uuid",
  "knowledgeId": "1717142400000-x7k2m9",
  "title":       "糖質制限の基本",
  "content":     "糖質を1日130g以下に抑えることで...",
  "tags":        ["食事制限", "代謝", "デスクワーク"],
  "createdAt":   "2026-05-28T07:30:00.000Z",
  "updatedAt":   "2026-05-28T07:30:00.000Z"
}
```

### 1.3 ai-todo-wl-todos

```
TableName: ai-todo-wl-todos
KeySchema:
  - AttributeName: userId (HASH)
  - AttributeName: todoId (RANGE)
AttributeDefinitions:
  - AttributeName: userId Type: S
  - AttributeName: todoId Type: S
  - AttributeName: date   Type: S
LocalSecondaryIndexes:
  - IndexName: DateIndex
    KeySchema:
      - AttributeName: userId (HASH)
      - AttributeName: date   (RANGE)
    Projection: ALL
BillingMode: PAY_PER_REQUEST
PointInTimeRecoveryEnabled: true
DeletionProtectionEnabled: true (RemovalPolicy.RETAIN)

Item Example:
{
  "userId":    "abc123-uuid",
  "todoId":    "1717142400000-p3q5r7",
  "title":     "20分ウォーキングする",
  "category":  "運動",
  "completed": false,
  "date":      "2026-05-28",
  "createdAt": "2026-05-28T07:00:00.000Z",
  "recurring": false,
  "completedDate": "2026-05-28"
}
```

属性補足:
| 属性名 | 型 | 説明 |
|--------|-----|------|
| recurring | BOOL (任意) | 定期タスクかどうか |
| completedDate | S (任意) | 完了した日付（ISO文字列）。定期タスクが翌日に未完了へリセットされる際の判定に使用 |

---

## 2. API Request/Response スキーマ

### 2.1 GET /wl/dashboard

Response 200:
```json
{
  "recentWeightLogs": [
    { "date": "2026-05-28", "weight": 72.5, "bmi": 23.6 }
  ],
  "todayTodoStats": {
    "total": 5,
    "completed": 2
  },
  "streak": 7,
  "latestWeight": 72.5,
  "recentKnowledgeCount": 12
}
```

### 2.2 GET /wl/weight-logs

Query Params: `?limit=30` (default: 30)

Response 200:
```json
[
  {
    "userId": "abc123",
    "date": "2026-05-28",
    "weight": 72.5,
    "bmi": 23.6,
    "memo": "朝食後",
    "createdAt": "2026-05-28T07:30:00Z"
  }
]
```

### 2.3 POST /wl/weight-logs

Request:
```json
{
  "date": "2026-05-28",
  "weight": 72.5,
  "memo": "朝食後"
}
```

Response 201:
```json
{
  "userId": "abc123",
  "date": "2026-05-28",
  "weight": 72.5,
  "bmi": 23.6,
  "memo": "朝食後",
  "createdAt": "2026-05-28T07:30:00Z"
}
```

### 2.4 DELETE /wl/weight-logs/{date}

Response 204: (empty body)

### 2.5 GET /wl/todos

Query Params: `?date=YYYY-MM-DD` (任意。省略時は全件)

Response 200:
```json
[
  {
    "userId": "abc123",
    "todoId": "1717142400000-abc",
    "title": "20分ウォーキングする",
    "category": "運動",
    "completed": false,
    "date": "2026-05-28",
    "createdAt": "2026-05-28T07:00:00Z"
  }
]
```

### 2.6 POST /wl/todos

通常作成:
```json
{
  "title": "20分ウォーキングする",
  "category": "運動",
  "date": "2026-05-28"
}
```

スターターキット作成:
```json
{
  "isTemplate": true,
  "date": "2026-05-28"
}
```

Response 201:
```json
{ "todoId": "...", "title": "...", ... }
// isTemplate: true の場合は配列
[{ ... }, { ... }, { ... }, { ... }, { ... }]
```

### 2.7 PUT /wl/todos/{todoId}

Request:
```json
{
  "completed": true
}
```

Response 200:
```json
{
  "userId": "abc123",
  "todoId": "...",
  "title": "20分ウォーキングする",
  "completed": true,
  ...
}
```

### 2.8 DELETE /wl/todos/{todoId}

Response 204: (empty body)

### 2.9 GET /wl/knowledge

Response 200:
```json
[
  {
    "userId": "abc123",
    "knowledgeId": "...",
    "title": "糖質制限の基本",
    "content": "...",
    "tags": ["食事制限", "代謝"],
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

### 2.10 POST /wl/knowledge

Request:
```json
{
  "title": "糖質制限の基本",
  "content": "糖質を1日130g以下に抑えることで...",
  "tags": ["食事制限", "代謝"]
}
```

Response 201: (作成されたアイテム)

### 2.11 PUT /wl/knowledge/{knowledgeId}

Request:
```json
{
  "title": "更新後タイトル",
  "content": "更新後本文",
  "tags": ["食事制限"]
}
```

Response 200: (更新後アイテム)

### 2.12 DELETE /wl/knowledge/{knowledgeId}

Response 204: (empty body)

### 2.13 GET /wl/profile

Response 200:
```json
{
  "userId": "abc123",
  "targetWeight": 65.0,
  "targetDate": "2026-12-31",
  "currentWeight": 72.5,
  "height": 170
}
```

### 2.14 PUT /wl/profile

Request（部分更新可）:
```json
{
  "targetWeight": 65.0,
  "targetDate": "2026-12-31"
}
```

Response 200: (更新後プロフィール)

### 2.15 POST /wl/chat

Request:
```json
{
  "message": "デスクワーク中に痩せるためのコツを教えて"
}
```

Response 200:
```json
{
  "reply": "あなたのメモによると、糖質制限と20分ウォーキングを実践中とのことですね。デスクワーク中は..."
}
```

---

## 3. Gemini プロンプト設計（RAGチャット）

### 3.1 ナレッジ検索ロジック
1. ユーザーのナレッジベースを全件取得（QueryCommand）
2. ユーザーメッセージのキーワードで簡易フィルタリング
   - タイトル・本文・タグにキーワードが含まれるもの優先
   - 5件以上の場合は上位5件に絞る
   - 0件の場合は最新5件を使用

### 3.2 システムプロンプト
```typescript
const prompt = `あなたは減量・ダイエットの専門AIアシスタントです。
ユーザーのナレッジベース（個人メモ）と一般知識を組み合わせて回答してください。

【ユーザーのナレッジベース】
${knowledgeContext}

【質問】
${userMessage}

【回答ルール】
- 300字以内で要点のみ簡潔に答える
- 詳細はナレッジに記録があれば「📚 ナレッジ『タイトル名』も参考に」と1行で案内する
- 丁寧語で、余計な前置き・まとめ文は不要`;
```

### 3.3 Gemini API 呼び出し
- エンドポイント: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`
- 認証: API Key（Secrets Managerから取得）
- リクエスト形式:
```json
{
  "contents": [
    {
      "parts": [{ "text": "<上記プロンプト>" }]
    }
  ]
}
```

---

## 4. フロントエンドコンポーネント設計

### 4.1 アプリ全体構成
```
weight-loss.html
├── <head>: スタイル定義（インライン CSS）
└── <body>
    ├── #profileModal: プロフィール設定モーダル（初回のみ）
    ├── #toast: トースト通知
    ├── .app-container
    │   ├── .sidebar: タブナビゲーション + ユーザー情報
    │   └── .main-content
    │       ├── #dashboardPage: ダッシュボード
    │       ├── #weightPage: 体重ログ
    │       ├── #todosPage: 減量ToDo
    │       ├── #knowledgePage: ナレッジベース
    │       └── #chatPage: AIチャット
    └── <script>: アプリロジック（インライン JS）
```

### 4.2 認証フロー
```javascript
// 起動時
1. localStorage から accessToken, idToken, refreshToken を取得
2. idToken の JWT payload をデコードして exp をチェック
3. 期限切れの場合: Cognito refreshToken エンドポイントで更新
4. トークンなし/更新失敗: Cognito Hosted UI にリダイレクト
5. URL に ?code= がある場合: 認証コードフロー（Hosted UI callback）

// API呼び出し時
const response = await fetch(url, {
  headers: { 'Authorization': `Bearer ${idToken}` }
});
// 401: トークン更新して再試行
```

### 4.3 体重グラフ（Canvas API）
```javascript
// drawWeightChart(logs, targetWeight)
// - 過去30日分のデータを折れ線で描画
// - X軸: 日付（6日ごとにラベル）
// - Y軸: 体重範囲（min-2kg 〜 max+2kg）
// - 実績: 緑色の折れ線（#22c55e）
// - 目標体重: オレンジ点線（#f97316）
// - グリッド線: 薄いグレー
```

### 4.4 状態管理
```javascript
// グローバル状態
const state = {
  weightLogs: [],       // 体重ログキャッシュ
  todos: [],            // ToDoキャッシュ
  knowledge: [],        // ナレッジキャッシュ
  chatHistory: [],      // チャット履歴（メモリのみ）
  currentTab: 'dashboard',
  profile: {            // LocalStorage: wl_height, wl_targetWeight, wl_targetDate
    height: null,
    targetWeight: null,
    targetDate: null,
  }
};
```

Gemini設定（APIキー・モデル名・スタブエンドポイント）は Secrets Manager から取得し、5分間のTTL（`GEMINI_CONFIG_TTL_MS`）でキャッシュする。また、Gemini のクォータを消費せずにテストできるよう、API Gateway の統合レスポンスをモックするスタブモードが用意されている。

### 4.5 カラーパレット
```css
:root {
  --primary: #22c55e;        /* メイングリーン */
  --primary-dark: #16a34a;   /* ダークグリーン */
  --primary-light: #bbf7d0;  /* ライトグリーン */
  --accent: #f97316;         /* オレンジ（目標体重ライン） */
  --danger: #ef4444;         /* 赤（削除・エラー） */
  --bg: #f0fdf4;             /* 薄いグリーン背景 */
  --text: #1a2e1a;           /* テキスト */
  --text-muted: #6b7280;     /* ミュートテキスト */
  --border: #d1fae5;         /* ボーダー */
}
```
