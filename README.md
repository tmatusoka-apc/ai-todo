# AI-Sync Health / AI Todo

> Gemini AIが伴走する、健康習慣化・減量サポート ToDo アプリ

[![Deploy](https://github.com/taisei1223/ai-todo/actions/workflows/deploy-aws.yml/badge.svg)](https://github.com/taisei1223/ai-todo/actions/workflows/deploy-aws.yml)

---

## 概要

運動・食事・睡眠の3カテゴリで健康タスクを管理し、**Gemini 2.5 Flash Lite** が今週の達成状況を分析して最適なタスクを自動提案するWebアプリです。減量に特化した専用サイト（ナレッジベース + AIチャット + 減量ToDo）も内包しています。

- **ポイント & レベルシステム** でモチベーション維持
- **習慣トラッキング** によるストリーク管理
- **グループ機能** で仲間と週間ランキングを競い合う
- **目標逆算プラン**（バックキャスト）をAIが自動生成
- **減量サポートサイト**：体重ログ・ナレッジベース・AIチャット・難易度別ToDo
- **管理者ダッシュボード** で組織全体の健康状態を可視化
- **GitHub Actions** による main ブランチへの push で AWS に自動デプロイ

---

## アーキテクチャ（AWS版・現行）

```
ブラウザ
  │ HTTPS
  ▼
Amazon CloudFront
  ├── /*      → S3 (index.html / weight-loss.html / admin-analysis.html)
  └── /v1/*   → API Gateway (Cognito Authorizer)
                  │
                  ▼
            8つの Lambda (Node.js 20 / TypeScript)
            ├── ai-todo-users        … プロフィール・バッジ
            ├── ai-todo-tasks        … タスクCRUD
            ├── ai-todo-habits       … 習慣トラッキング
            ├── ai-todo-groups       … グループ・ランキング・フィード
            ├── ai-todo-ai           … AIタスク提案（Gemini）
            ├── ai-todo-analytics    … 管理者向け集計
            ├── ai-todo-goals        … 目標バックキャスト（Gemini）
            └── ai-todo-weight-loss  … 減量サポート全般（Gemini RAGチャット）
                  │
                  ├── DynamoDB（users / tasks / habits / groups / groupMembers /
                  │              goals / activities / wl-weight-logs /
                  │              wl-knowledge / wl-todos）
                  └── Secrets Manager（ai-todo/gemini-api-key, 許可ドメイン）
                        │
                        ▼
                  Google Gemini API (gemini-2.5-flash-lite)
                  ※ Secrets Manager の stubEndpoint 設定でAPIGW Mock統合の
                    スタブに切り替え可能（クォータ消費ゼロでテスト可）

Amazon Cognito（Hosted UI 認証 / JWT検証）
```

| レイヤー | 技術 |
|---------|------|
| フロントエンド | HTML5 / CSS3 / Vanilla JS（`index.html`, `weight-loss.html`, `admin-analysis.html`） |
| バックエンド | AWS Lambda (Node.js 20 / TypeScript) + API Gateway |
| インフラ管理 | AWS CDK (TypeScript) |
| データ保存 | Amazon DynamoDB（PAY_PER_REQUEST） |
| 認証 | Amazon Cognito（Hosted UI + JWT） |
| 配信 | Amazon CloudFront + S3 |
| AI | Google Gemini API（`gemini-2.5-flash-lite`） |
| シークレット管理 | AWS Secrets Manager（5分TTLキャッシュ） |
| CI/CD | GitHub Actions（`cdk deploy --all`） |

---

## 主な機能

### Health Todo（メイン）
- タスク・習慣管理、ポイント・レベル・バッジシステム
- AIによる週次・日次タスク提案（達成率分析）
- グループ作成・参加（参加IDをコピーして共有）、週間ランキング、活動フィード
- 目標逆算プラン（AIが週ごとの行動計画を自動生成）
- 管理者ダッシュボード（admin/analystロールのみ）

### 減量サポート（`weight-loss.html`）
- 体重ログ・BMI自動計算・グラフ表示
- 減量ToDo：難易度別スターターキット、**定期タスク**（完了翌日に自動で未完了へリセット）、不定期タスク
- ナレッジベース：テンプレート機能（ダイエット/トレーニング/サプリ/生活習慣）
- AIチャット：個人ナレッジを踏まえたRAGチャット（300字程度に要約、関連ナレッジを案内）
  - AI回答からチェックボックスで複数ToDoへ一括追加可能（最大5件）
- メインサイトとの相互リンク（サイドバーから行き来可能）

---

## デプロイ

### 前提：GitHub Secrets

| Secret名 | 内容 |
|---------|------|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | デプロイ用IAMユーザー |
| `GEMINI_MODEL` | 使用するGeminiモデル（未設定時は `gemini-2.5-flash-lite`） |
| `ALLOWED_ORIGIN` | CORS許可オリジン（CloudFront URL） |

### デプロイ実行

```bash
git push origin main  # → GitHub Actions が cdk deploy --all を自動実行
```

ローカルから直接デプロイする場合：
```bash
cd cdk
npm ci
npx cdk deploy --all
```

### Gemini APIキーの設定

```bash
aws secretsmanager put-secret-value \
  --secret-id ai-todo/gemini-api-key \
  --secret-string '{"apiKey": "YOUR_GEMINI_API_KEY"}'
```

スタブ（モック応答）への切り替え手順は [`docs/gemini-stub-operations.md`](docs/gemini-stub-operations.md) を参照。

---

## 管理者ダッシュボード

`index.html` のサイドバーに `🔐 管理ダッシュボード` リンクが表示されます（admin/analystロールのみ）。直接アクセスする場合は `/admin-analysis.html`。

---

## コスト管理

- 全AWSリソースに `Project=ai-todo` / `Env=prod` / `ManagedBy=cdk` タグを付与（コスト配分タグとして利用可）
- Gemini APIコストの試算は [`docs/gemini-api-cost-analysis.md`](docs/gemini-api-cost-analysis.md) を参照
- Gemini APIはクレジット枯渇時に `429 RESOURCE_EXHAUSTED` を返し、自動でフォールバック（ルールベース提案）に切り替わる

---

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [利用手順書](docs/user-guide.md) | エンドユーザー向け操作ガイド（Health Todo・減量サポートの使い方、FAQ） |
| [要件定義書（減量サポート）](docs/requirements-weight-loss.md) | 減量サポートサイトの機能要件・非機能要件 |
| [基本設計書（減量サポート）](docs/basic-design-weight-loss.md) | システム構成・DynamoDB設計・API一覧・画面遷移 |
| [詳細設計書（減量サポート）](docs/detail-design-weight-loss.md) | テーブル詳細・APIスキーマ・Geminiプロンプト設計 |
| [Gemini APIコスト試算](docs/gemini-api-cost-analysis.md) | モデル料金・呼び出しパターン・人数別コスト試算・予算超過対策 |
| [Geminiスタブ運用手順書](docs/gemini-stub-operations.md) | 本番⇄スタブの切り替え手順・トラブルシューティング |
| [構成図](docs/architecture.drawio) | システム全体構成図（Draw.io） |
| [技術構成案](docs/20260526_技術構成案.docx) | 初期技術検討資料 |
| [AWS-CDK版技術構成案](docs/20260528_技術構成案_AWS-CDK版.docx) | AWS移行後の技術構成 |
| [アプリ計画案](docs/20260526_アプリ計画案.docx) | 実装済み機能とビジョン機能の整理 |
| [ユーザー一日の流れ](docs/20260526_アプリ計画-ユーザー一日の流れ.docx) | ペルソナによるユーザー体験ストーリー |
