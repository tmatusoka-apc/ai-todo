import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
);
const sm = new SecretsManagerClient({ region: process.env.REGION });

const GEMINI_SECRET_ARN = process.env.GEMINI_SECRET_ARN!;
const GOALS_TABLE       = process.env.GOALS_TABLE!;
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN ?? '*';

// Fallback suggestions when Gemini is unavailable
const FALLBACKS: Record<string, string[]> = {
  exercise: ['腹筋20回', 'ジョギング20分', 'スクワット30回', 'ヨガ15分', 'ストレッチ'],
  diet: ['水2L摂取', 'サラダを食べる', 'タンパク質摂取', '野菜ジュース', 'ナッツを食べる'],
  sleep: ['22時に就寝', 'スマホを手放す', '腹式呼吸', '読書15分', 'アロマを焚く'],
};

function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
    body: JSON.stringify(body),
  };
}

function err(message: string, status = 400): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
    body: JSON.stringify({ message }),
  };
}

function getUserId(event: APIGatewayProxyEvent): string {
  return event.requestContext.authorizer?.claims?.sub as string;
}

async function getApiKey(): Promise<string> {
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: GEMINI_SECRET_ARN }),
  );
  const secret = JSON.parse(res.SecretString ?? '{}');
  return secret.apiKey as string;
}

function buildWeekSummary(typeCounts: Record<string, { total: number; completed: number }>): string {
  return Object.entries(typeCounts)
    .map(([type, { total, completed }]) => {
      const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
      return `${type}: ${completed}/${total}件完了 (${rate}%)`;
    })
    .join('\n');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const reqBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody,
    });

    if (res.ok) {
      const json = (await res.json()) as {
        candidates: { content: { parts: { text: string }[] } }[];
      };
      return json.candidates[0].content.parts[0].text;
    }

    if (res.status === 429) {
      const errBody = await res.text().catch(() => '');
      if (errBody.includes('RESOURCE_EXHAUSTED') || errBody.includes('depleted') || errBody.includes('quota')) {
        throw new Error(`Gemini error: 429 ${errBody.substring(0, 300)}`);
      }
      if (attempt < 2) {
        const waitMs = Math.pow(5, attempt) * 1000;
        console.warn(`[callGemini] 429 rate limited, retry ${attempt + 1}/3 in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
    }

    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini error: ${res.status} ${errBody.substring(0, 300)}`);
  }

  throw new Error('Gemini error: max retries exceeded');
}

function extractJson<T>(text: string): T | null {
  const match = text.match(/\[[\s\S]*?\]|\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

function fallbackSuggestion(typeCounts: Record<string, { total: number; completed: number }>) {
  const rates = Object.entries(typeCounts).map(([type, { total, completed }]) => ({
    type,
    rate: total > 0 ? completed / total : 1,
  }));
  rates.sort((a, b) => a.rate - b.rate);
  const worst = rates[0]?.type ?? 'exercise';
  const titles = FALLBACKS[worst] ?? FALLBACKS.exercise;
  const title = titles[Math.floor(Math.random() * titles.length)];
  return { type: worst, title, reason: 'この分野を強化しましょう！' };
}

function fallbackSuggestions() {
  const result: { type: string; title: string }[] = [];
  for (const type of ['exercise', 'diet', 'sleep']) {
    const pool = [...FALLBACKS[type]];
    for (let i = 0; i < 2; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      result.push({ type, title: pool[idx] });
      pool.splice(idx, 1);
    }
  }
  return result;
}

/** Fetch the user's active goals from DynamoDB */
async function fetchActiveGoals(userId: string): Promise<{ title: string; targetDate: string; category: string }[]> {
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: GOALS_TABLE,
        KeyConditionExpression: 'userId = :uid',
        FilterExpression: 'active = :t',
        ExpressionAttributeValues: { ':uid': userId, ':t': true },
      }),
    );
    return (res.Items ?? []).map((g) => ({
      title: g.title as string,
      targetDate: g.targetDate as string,
      category: g.category as string,
    }));
  } catch {
    return [];
  }
}

function buildGoalContext(goals: { title: string; targetDate: string; category: string }[]): string {
  if (!goals.length) return '';
  return '\n\nユーザーの目標:\n' + goals
    .map((g) => `- ${g.title}（目標期日: ${g.targetDate}、カテゴリ: ${g.category}）`)
    .join('\n');
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const resource = event.resource;
  const userId = getUserId(event);
  if (!userId) return err('Unauthorized', 401);

  try {
    const body = JSON.parse(event.body ?? '{}');
    const typeCounts: Record<string, { total: number; completed: number }> =
      body.typeCounts ?? {};
    const resilienceScore: number = body.resilienceScore ?? 0;
    const goal: string = body.goal ?? '';

    // POST /ai/suggestion – single daily recommendation
    if (resource.endsWith('/suggestion')) {
      // Fetch active goals for goal-aware prompt
      const activeGoals = await fetchActiveGoals(userId);
      const goalContext = buildGoalContext(activeGoals);

      const resilienceContext = resilienceScore > 0
        ? `\n\n継続力スコア: ${resilienceScore}点 (${resilienceScore >= 70 ? '高い' : resilienceScore >= 40 ? '普通' : '低め'} — ${resilienceScore < 40 ? 'やさしめのタスクで復帰を後押しして' : ''})`
        : '';

      const userGoalNote = goal ? `\nユーザーの直近の目標メモ: ${goal}` : '';

      try {
        const apiKey = await getApiKey();
        const summary = buildWeekSummary(typeCounts);
        const prompt = `
あなたは健康習慣コーチです。
以下の今週の活動データを分析して、今日取り組むべき1つのタスクを提案してください。${resilienceContext}${userGoalNote}${goalContext}

今週の活動:
${summary}

以下のJSON形式だけで回答してください（説明不要）:
{"type":"exercise|diet|sleep","title":"タスク名（15文字以内）","reason":"理由（40文字以内）"}
`.trim();

        const text = await callGemini(prompt, apiKey);
        const suggestion = extractJson<{ type: string; title: string; reason: string }>(text);
        if (suggestion) return ok(suggestion);
      } catch (e) {
        console.warn('Gemini unavailable, using fallback:', e);
      }
      return ok(fallbackSuggestion(typeCounts));
    }

    // POST /ai/suggestions – 6 tasks (2 per category)
    if (resource.endsWith('/suggestions')) {
      const activeGoals = await fetchActiveGoals(userId);
      const goalContext = buildGoalContext(activeGoals);
      const userGoalNote = goal ? `\nユーザーの直近の目標メモ: ${goal}` : '';

      try {
        const apiKey = await getApiKey();
        const summary = buildWeekSummary(typeCounts);
        const prompt = `
あなたは健康習慣コーチです。
以下の今週の活動データを参考に、今週取り組むべきタスクをexercise・diet・sleepそれぞれ2件ずつ、合計6件提案してください。${userGoalNote}${goalContext}

今週の活動:
${summary}

以下のJSON配列形式だけで回答してください（説明不要）:
[
  {"type":"exercise","title":"タスク名（15文字以内）"},
  {"type":"exercise","title":"タスク名（15文字以内）"},
  {"type":"diet","title":"タスク名（15文字以内）"},
  {"type":"diet","title":"タスク名（15文字以内）"},
  {"type":"sleep","title":"タスク名（15文字以内）"},
  {"type":"sleep","title":"タスク名（15文字以内）"}
]
`.trim();

        const text = await callGemini(prompt, apiKey);
        const suggestions = extractJson<{ type: string; title: string }[]>(text);
        if (suggestions && Array.isArray(suggestions) && suggestions.length >= 6) {
          return ok(suggestions.slice(0, 6));
        }
      } catch (e) {
        console.warn('Gemini unavailable, using fallback:', e);
      }
      return ok(fallbackSuggestions());
    }

    return err('Not found', 404);
  } catch (e) {
    console.error(e);
    return err('Internal server error', 500);
  }
};
