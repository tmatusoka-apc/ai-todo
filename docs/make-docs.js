const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, ShadingType, BorderStyle,
} = require('C:/Users/taise/AppData/Roaming/npm/node_modules/docx');
const fs = require('fs');
const path = require('path');

// ---- helpers ----
const bd  = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const bds = { top: bd, bottom: bd, left: bd, right: bd };
const cm  = { top: 80, bottom: 80, left: 180, right: 180 };

function hd1(txt) {
  return new TableCell({
    borders: bds, shading: { fill: '2C3E50', type: ShadingType.CLEAR },
    margins: cm, width: { size: 3000, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: txt, bold: true, color: 'FFFFFF', size: 20, font: 'Meiryo' })] })],
  });
}
function hd2(txt) {
  return new TableCell({
    borders: bds, shading: { fill: '34495E', type: ShadingType.CLEAR },
    margins: cm, width: { size: 6026, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: txt, color: 'FFFFFF', size: 20, font: 'Meiryo' })] })],
  });
}
function c1(txt) {
  return new TableCell({
    borders: bds, shading: { fill: 'ECF0F1', type: ShadingType.CLEAR },
    margins: cm, width: { size: 3000, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: txt, bold: true, color: '2C3E50', size: 20, font: 'Meiryo' })] })],
  });
}
function c2(txt) {
  return new TableCell({
    borders: bds, shading: { fill: 'FDFEFE', type: ShadingType.CLEAR },
    margins: cm, width: { size: 6026, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: txt, size: 20, font: 'Meiryo' })] })],
  });
}
function tbl(rows) {
  return new Table({ width: { size: 9026, type: WidthType.DXA }, columnWidths: [3000, 6026], rows });
}
function tr(a, b) { return new TableRow({ children: [a, b] }); }
function h1(emoji, title) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: emoji + ' ' + title, bold: true, color: '1A252F', size: 32, font: 'Meiryo' })],
  });
}
function h2(title) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: title, bold: true, color: '2980B9', size: 26, font: 'Meiryo' })],
  });
}
function blt(txt) {
  return new Paragraph({ children: [new TextRun({ text: '• ' + txt, size: 20, font: 'Meiryo' })] });
}
function sp() { return new Paragraph({ children: [] }); }

// ---- document ----
const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
      },
    },
    children: [
      // Title block
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ text: 'AI-Sync Health', bold: true, color: '1A252F', size: 44, font: 'Meiryo' })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
        children: [new TextRun({ text: '技術構成案（Ver 4.0 / 継続力・フィード・目標逆算 実装版）', bold: true, color: '2980B9', size: 28, font: 'Meiryo' })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
        children: [new TextRun({ text: '更新日: 2026-05-28  |  4機能追加実装完了', color: '7F8C8D', size: 20, font: 'Meiryo' })] }),
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BDC3C7', space: 4 } },
        spacing: { after: 160 }, children: [],
      }),

      // 1. ステータス
      h1('📋', '実装ステータスサマリ'),
      tbl([
        tr(hd1('項目'), hd2('内容')),
        tr(c1('デプロイ先'),        c2('AWS (CloudFront + API Gateway + Lambda + DynamoDB + Cognito)')),
        tr(c1('WebアプリURL'),      c2('https://<CloudFront-ID>.cloudfront.net  (GitHub Actions がデプロイ時に自動注入)')),
        tr(c1('AIモデル'),          c2('Gemini 2.0 Flash  (google/gemini-2.0-flash)')),
        tr(c1('認証'),              c2('Amazon Cognito User Pools  (SRP + Email 確認 + Pre-SignUp ドメイン制限)')),
        tr(c1('データ永続化'),      c2('Amazon DynamoDB  PAY_PER_REQUEST  (5テーブル / PITR 有効)')),
        tr(c1('セキュリティ'),      c2('JWT / escapeHtml XSS 対策 / JWT 自動リフレッシュ / CORS ALLOWED_ORIGIN')),
        tr(c1('CI/CD'),             c2('.github/workflows/deploy-aws.yml  →  cdk deploy --all  →  S3 upload  →  CF invalidation')),
      ]),
      sp(),

      // 2. アーキテクチャ
      h1('🏗️', 'AWSアーキテクチャ（3スタック構成）'),
      h2('スタック依存関係'),
      tbl([
        tr(hd1('スタック'), hd2('役割')),
        tr(c1('AiTodoSecurityStack'),
           c2('Cognito User Pool / admin・analyst・user グループ / IAM ロール / Secrets Manager (Gemini API キー、許可ドメイン) / Pre-SignUp Lambda / Post-Confirmation Lambda')),
        tr(c1('AiTodoInfraStack'),
           c2('DynamoDB 7テーブル: users / tasks (LSI:DateIndex) / habits / groups / groupMembers (GSI:UserGroupsIndex) / goals / activities (TTL:30日)')),
        tr(c1('AiTodoAppStack'),
           c2('Lambda × 7 + トリガー × 2 / API Gateway REST (v1) / S3 フロントエンドバケット / CloudFront ディストリビューション')),
      ]),
      sp(),
      h2('CloudFront ルーティング'),
      tbl([
        tr(hd1('パス'), hd2('オリジン / 説明')),
        tr(c1('/* (Default)'), c2('S3 Origin (OAC) — index.html / admin-analysis.html 静的配信。SPA fallback (403/404 → index.html)')),
        tr(c1('/v1/*'),        c2('API Gateway Origin (RestApiOrigin) — Lambda プロキシ / キャッシュ無効 / Authorization ヘッダー通過')),
      ]),
      sp(),

      // 3. Lambda
      h1('⚡', 'Lambda 関数一覧  (Node.js 20 / 512 MB / 30s)'),
      tbl([
        tr(hd1('関数名'), hd2('役割・エンドポイント')),
        tr(c1('ai-todo-users'),       c2('GET /users/me  |  PUT /users/me (fullName, goal, resilienceScore 等)  |  GET /users/me/badges')),
        tr(c1('ai-todo-tasks'),       c2('GET/POST /tasks  |  PUT/DELETE /tasks/{taskId}  ※完了時に isTaskPublic チェック → activities テーブルへ活動記録')),
        tr(c1('ai-todo-habits'),      c2('GET/POST /habits  |  PUT/DELETE /habits/{habitId}  |  POST /habits/{habitId}/complete  ※ギャップ検出 → resilienceScore 更新 → activities 記録')),
        tr(c1('ai-todo-groups'),      c2('GET/POST /groups  |  GET/DELETE /groups/{groupId}  |  POST/DELETE /groups/{groupId}/members  |  GET /groups/{groupId}/ranking  |  GET /groups/{groupId}/feed  |  POST /groups/{groupId}/feed/{activityId}/react  |  DELETE .../unreact')),
        tr(c1('ai-todo-goals'),       c2('GET/POST /goals  |  PUT/DELETE /goals/{goalId}  |  POST /ai/backcast  ※Gemini で実現可能性判定 + 週別タスクプラン生成 (60s timeout)')),
        tr(c1('ai-todo-ai'),          c2('POST /ai/suggestion (今日の提案 1件)  |  POST /ai/suggestions (カテゴリ別 6件)  ※目標・継続力スコアをプロンプトに含む (60s timeout)')),
        tr(c1('ai-todo-analytics'),   c2('GET /analytics/summary  ※ admin/analyst ロールのみ。cognito:groups クレームを Lambda 内で検証')),
        tr(c1('ai-todo-pre-signup'),  c2('Cognito Pre-SignUp トリガー — Secrets Manager からドメインを取得してメール検証 (128 MB / 10s)')),
        tr(c1('ai-todo-post-conf.'),  c2('Cognito Post-Confirmation トリガー — 確認完了ユーザーを自動で user グループに追加 (128 MB / 10s)')),
      ]),
      sp(),

      // 4. AI
      h1('🤖', 'AI統合（Gemini 2.0 Flash）'),
      h2('呼び出しフロー'),
      blt('フロントエンド (index.html) が api() ラッパー経由で POST /v1/ai/suggestion を呼び出し'),
      blt('api() は JWT の exp クレームを確認し、5分以内に期限切れなら Cognito getSession() で自動リフレッシュ'),
      blt('CloudFront → API Gateway → Cognito Authorizer → Lambda → Gemini API'),
      blt('API キーは Secrets Manager (ai-todo/gemini-api-key) に格納。Lambda が GetSecretValue で取得'),
      blt('Gemini API エラー / タイムアウト時はルールベース fallback で UX を維持'),
      sp(),
      h2('プロンプト設計'),
      blt('ダッシュボード推薦 (/ai/suggestion): 今週の活動 + ユーザー目標メモ + 継続力スコア + 設定済み目標一覧 → 今日の最適タスク 1件 (JSON)'),
      blt('タスク一覧推薦 (/ai/suggestions): 同データ → カテゴリ別 2件 × 3 = 計 6件（JSON 配列）'),
      blt('目標逆算 (/ai/backcast, goals Lambda): 目標名 + 期日 + カテゴリ + 現状 → feasibility(realistic/challenging/unrealistic) + 週別タスクプラン（最大 12週）'),
      blt('継続力スコア: ギャップ日数ベースの速度得点 × (復帰回数/総ギャップ数) で算出。低スコア時はやさしめタスクを提案'),
      blt('maxOutputTokens: 512(提案) / 1024(逆算) / temperature: 0.7 / JSON のみで回答を強制'),
      sp(),

      // 5. CI/CD
      h1('🚀', 'CI/CD（GitHub Actions）'),
      h2('.github/workflows/deploy-aws.yml のステップ'),
      blt('1. actions/checkout — コード取得'),
      blt('2. actions/setup-node@v4 — Node.js 20 セットアップ'),
      blt('3. aws-actions/configure-aws-credentials@v4 — AWS 認証 (ap-northeast-1)'),
      blt('4. npm ci (cdk/) — CDK 依存パッケージインストール'),
      blt('5. cdk deploy --all — 3スタック全デプロイ。cdk-outputs.json 出力。ALLOWED_ORIGIN / SES_FROM_EMAIL を env で渡す'),
      blt('6a. secretsmanager put-secret-value — Gemini API キーを Secrets Manager に保存'),
      blt('6b. secretsmanager put-secret-value — 許可サインアップドメインを Secrets Manager に保存'),
      blt('7. jq で cdk-outputs.json から CF URL / UserPoolId / ClientId を抽出'),
      blt('8. sed で index.html / admin-analysis.html のプレースホルダーを実値に置換'),
      blt('9. aws s3 cp — S3 に静的ファイルをアップロード'),
      blt('10. cloudfront create-invalidation — キャッシュ無効化'),
      sp(),
      h2('GitHub Secrets 一覧'),
      tbl([
        tr(hd1('Secret 名'), hd2('内容')),
        tr(c1('AWS_ACCESS_KEY_ID'),      c2('AWS IAM アクセスキー ID')),
        tr(c1('AWS_SECRET_ACCESS_KEY'),  c2('AWS IAM シークレットアクセスキー')),
        tr(c1('GEMINI_API_KEY'),         c2('Google Gemini API キー')),
        tr(c1('CLOUDFRONT_URL'),         c2('初回デプロイ後に登録。CORS の ALLOWED_ORIGIN に使用 (例: https://d1234.cloudfront.net)')),
        tr(c1('SES_FROM_EMAIL'),         c2('(任意) Cognito メール送信元を SES に変更する場合に設定')),
        tr(c1('ALLOWED_SIGNUP_DOMAIN'),  c2('(任意) サインアップ許可ドメイン。未設定時は ap-com.co.jp')),
      ]),
      sp(),

      // 6. セキュリティ
      h1('🔐', 'セキュリティ設計'),
      tbl([
        tr(hd1('対策'), hd2('実装内容')),
        tr(c1('認証'),              c2('Amazon Cognito SRP 認証。JWT ID Token を Authorization ヘッダーで全 API に送信')),
        tr(c1('ドメイン制限'),      c2('Pre-SignUp Lambda が Secrets Manager からドメインを取得して検証。指定ドメイン外は登録不可')),
        tr(c1('ロールベース認可'),  c2('admin(P=1) / analyst(P=5) / user(P=10) の 3グループ。analytics API は Lambda 内で cognito:groups クレームを検証')),
        tr(c1('CORS'),              c2('ALLOWED_ORIGIN 環境変数。CLOUDFRONT_URL 設定後は * → 実ドメインに制限')),
        tr(c1('JWT自動リフレッシュ'), c2('api() 呼び出し前に exp クレームを確認。期限 5分前に Cognito getSession() でリフレッシュ')),
        tr(c1('XSS 対策'),         c2('escapeHtml() で & < > " \' をエスケープ。全 innerHTML 挿入箇所に適用')),
        tr(c1('シークレット管理'),  c2('API キー等は GitHub Secrets / Secrets Manager で管理。ハードコードなし')),
        tr(c1('AI コスト制御'),     c2('AI エンドポイントは Cognito 認証必須 (未認証リクエストを API Gateway でブロック)')),
      ]),
      sp(),

      // 7. データモデル
      h1('🗄️', 'DynamoDB テーブル設計'),
      tbl([
        tr(hd1('テーブル'), hd2('PK / SK / インデックス / 新規属性')),
        tr(c1('users'),        c2('PK: userId  |  NEW: resilienceScore / comebackCount / avgGapDays / goal')),
        tr(c1('tasks'),        c2('PK: userId  SK: taskId  |  LSI: DateIndex  (SK: date)')),
        tr(c1('habits'),       c2('PK: userId  SK: habitId  |  NEW: gapEvents [{date, gapDays}]')),
        tr(c1('groups'),       c2('PK: groupId')),
        tr(c1('groupMembers'), c2('PK: groupId  SK: userId  |  GSI: UserGroupsIndex  (PK: userId)')),
        tr(c1('goals'),        c2('PK: userId  SK: goalId  |  NEW: feasibility / warning / weeklyPlan / active')),
        tr(c1('activities'),   c2('PK: groupId  SK: activityId(timestamp#uuid)  |  TTL: 30日自動削除  |  reactions: {userId: type}')),
      ]),
      sp(),

      // 8. 新機能
      h1('🆕', '追加機能（Ver 4.0）'),
      h2('① 継続力スコア'),
      blt('habits Lambda: POST /habits/{habitId}/complete でギャップ日数を計算（lastCompletedDate との差）'),
      blt('ギャップ > 2日 = 復帰イベントを gapEvents 配列に記録'),
      blt('スコア算式: Σ速度得点(≤3d=10, ≤7d=7, ≤14d=4, ≤30d=2, >30d=1) × (復帰回数/総ギャップ数)'),
      blt('users テーブルに resilienceScore / comebackCount / avgGapDays を更新'),
      blt('フロントエンド: ダッシュボードにグラデーションカード表示。AI提案プロンプトに継続力スコアを追加'),
      sp(),
      h2('② Activity Feed + 応援リアクション'),
      blt('習慣完了・タスク完了時に isTaskPublic チェック → ユーザーのグループに activities アイテムを POST'),
      blt('groups Lambda: GET /groups/{groupId}/feed（最新30件・新しい順）'),
      blt('groups Lambda: POST /groups/{groupId}/feed/{activityId}/react（reactions.{userId} = type）'),
      blt('groups Lambda: DELETE .../unreact（REMOVE reactions.{userId}）'),
      blt('フロントエンド: グループカードにランキング/フィードタブ追加。リアクションボタン（👍📣🔥）'),
      sp(),
      h2('③ 目標から逆算タスク作成'),
      blt('新 Lambda (ai-todo-goals): POST /goals → Gemini で feasibility + 週別タスクプラン生成'),
      blt('feasibility: realistic / challenging / unrealistic。unrealistic 時は warning 文を表示'),
      blt('GET /goals で一覧取得。PUT/DELETE /goals/{goalId} で管理'),
      blt('POST /ai/backcast エンドポイントで既存目標の再プランニングも可能'),
      blt('フロントエンド: プロフィールページに目標管理セクション追加。週別プランを折りたたみ表示'),
      sp(),
      h2('④ 逆算ベースAI提案'),
      blt('ai Lambda の /suggestion・/suggestions が goals テーブルから active な目標を取得'),
      blt('目標タイトル・期日・カテゴリをプロンプトに追加し、目標に沿ったタスクを優先提案'),
      blt('継続力スコアが低い場合（< 40点）はやさしめのタスクを提案するよう指示'),
      blt('フロントエンド側でも resilienceScore を api() ラッパーで /ai/suggestion リクエストに含める'),
      sp(),

      // 9. フロントエンド
      h1('💻', 'フロントエンド設計'),
      h2('データフロー（楽観的更新パターン）'),
      blt('ローカル操作は localStorage に即時反映 → UI を同期的に更新'),
      blt('非同期で api() 経由 DynamoDB に保存'),
      blt('ローカル仮 ID (String(Date.now())) を API 発行の本 ID に差し替え'),
      blt('ログイン後・ページ読み込み後に syncFromApi() を呼び出してタスク/習慣/グループを DynamoDB から同期'),
      sp(),
      h2('Cognito 認証フロー'),
      blt('SRP 認証 (amazon-cognito-identity-js SDK)'),
      blt('サインアップ → Pre-SignUp Lambda ドメイン検証 → メール確認コード'),
      blt('Post-Confirmation Lambda が user グループに自動追加'),
      blt('ページロード時 getSession() でセッション復元 + トークン更新'),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const out = path.join(__dirname, '20260528_技術構成案_AWS-CDK版.docx');
  fs.writeFileSync(out, buf);
  console.log('wrote: ' + out);
}).catch((e) => console.error(e));
