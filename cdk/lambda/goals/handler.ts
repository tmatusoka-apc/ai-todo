import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
);
const sm = new SecretsManagerClient({ region: process.env.REGION });

const GOALS_TABLE      = process.env.GOALS_TABLE!;
const GEMINI_SECRET_ARN = process.env.GEMINI_SECRET_ARN!;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN ?? '*';
const GEMINI_MODEL     = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return {
    statusCode: status,
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
  const res = await sm.send(new GetSecretValueCommand({ SecretId: GEMINI_SECRET_ARN }));
  const secret = JSON.parse(res.SecretString ?? '{}');
  return secret.apiKey as string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const reqBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 1024 },
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
  // Use greedy match so nested JSON objects/arrays are captured completely.
  // Order: object first (backcast always returns {}), then array.
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as T; } catch { return null; }
}

interface BackcastResult {
  feasibility: 'realistic' | 'challenging' | 'unrealistic';
  warning?: string;
  weeklyPlan: { week: number; tasks: string[] }[];
}

function fallbackBackcast(goal: string, durationWeeks: number): BackcastResult {
  const planWeeks = Math.min(durationWeeks, 12);
  const weeklyPlan = Array.from({ length: planWeeks }, (_, i) => ({
    week: i + 1,
    tasks: [
      i < planWeeks / 3 ? '基礎固め：現状把握と準備' :
      i < planWeeks * 2 / 3 ? '実践：習慣化と継続' : '仕上げ：定着と振り返り',
    ],
  }));
  return {
    feasibility: 'challenging',
    warning: undefined,
    weeklyPlan,
  };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  const method = event.httpMethod;
  const goalId = event.pathParameters?.goalId;
  const resource = event.resource;

  try {
    // GET /goals – list user's goals
    if (method === 'GET' && !goalId && resource.endsWith('/goals')) {
      const result = await ddb.send(
        new QueryCommand({
          TableName: GOALS_TABLE,
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': userId },
        }),
      );
      return ok(result.Items ?? []);
    }

    // POST /goals – create goal with AI backcast
    if (method === 'POST' && resource.endsWith('/goals')) {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.title || !body.targetDate) {
        return err('title and targetDate are required');
      }

      const targetDate = new Date(body.targetDate as string);
      const now = new Date();
      const durationWeeks = Math.max(
        1,
        Math.round((targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 7)),
      );

      // Generate AI backcast plan
      let backcast: BackcastResult;
      try {
        const apiKey = await getApiKey();
        const prompt = `
あなたは健康・生活習慣コーチです。
ユーザーが以下の目標を設定しました。

目標: ${body.title}
達成期限: ${body.targetDate} (約${durationWeeks}週間後)
カテゴリ: ${body.category ?? '未分類'}
現在の状況: ${body.currentStatus ?? '特になし'}

以下のJSON形式だけで回答してください（説明不要）:
{
  "feasibility": "realistic|challenging|unrealistic",
  "warning": "実現困難な場合の注意文（40文字以内）またはnull",
  "weeklyPlan": [
    {"week": 1, "tasks": ["タスク1（20文字以内）", "タスク2（20文字以内）"]},
    ...最大${Math.min(durationWeeks, 12)}週分
  ]
}
`.trim();

        const text = await callGemini(prompt, apiKey);
        backcast = extractJson<BackcastResult>(text) ?? fallbackBackcast(body.title as string, durationWeeks);
      } catch (e) {
        console.warn('Gemini unavailable for backcast, using fallback:', e);
        backcast = fallbackBackcast(body.title as string, durationWeeks);
      }

      const newGoalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const goal = {
        userId,
        goalId: newGoalId,
        title: body.title as string,
        targetDate: body.targetDate as string,
        category: (body.category as string) ?? 'general',
        currentStatus: (body.currentStatus as string) ?? '',
        feasibility: backcast.feasibility,
        warning: backcast.warning ?? null,
        weeklyPlan: backcast.weeklyPlan,
        active: true,
        createdAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: GOALS_TABLE, Item: goal }));
      return ok(goal, 201);
    }

    // POST /ai/backcast – regenerate backcast for an existing goal
    if (method === 'POST' && resource.endsWith('/backcast')) {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.title || !body.targetDate) {
        return err('title and targetDate are required');
      }

      const targetDate = new Date(body.targetDate as string);
      const now = new Date();
      const durationWeeks = Math.max(
        1,
        Math.round((targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 7)),
      );

      let backcast: BackcastResult;
      try {
        const apiKey = await getApiKey();
        const prompt = `
あなたは健康・生活習慣コーチです。
ユーザーが以下の目標を設定しました。

目標: ${body.title}
達成期限: ${body.targetDate} (約${durationWeeks}週間後)
カテゴリ: ${body.category ?? '未分類'}
現在の状況: ${body.currentStatus ?? '特になし'}

以下のJSON形式だけで回答してください（説明不要）:
{
  "feasibility": "realistic|challenging|unrealistic",
  "warning": "実現困難な場合の注意文（40文字以内）またはnull",
  "weeklyPlan": [
    {"week": 1, "tasks": ["タスク1（20文字以内）", "タスク2（20文字以内）"]},
    ...最大${Math.min(durationWeeks, 12)}週分
  ]
}
`.trim();

        const text = await callGemini(prompt, apiKey);
        backcast = extractJson<BackcastResult>(text) ?? fallbackBackcast(body.title as string, durationWeeks);
      } catch (e) {
        console.warn('Gemini unavailable for backcast, using fallback:', e);
        backcast = fallbackBackcast(body.title as string, durationWeeks);
      }

      return ok(backcast);
    }

    // PUT /goals/{goalId}
    if (method === 'PUT' && goalId) {
      const body = JSON.parse(event.body ?? '{}');
      const allowed = ['title', 'targetDate', 'category', 'currentStatus', 'active'];
      const updates = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k)),
      );
      if (!Object.keys(updates).length) return err('No valid fields to update');

      const keys = Object.keys(updates);
      const expr = keys.map((k, i) => `#k${i} = :v${i}`).join(', ');
      const names = Object.fromEntries(keys.map((k, i) => [`#k${i}`, k]));
      const vals = Object.fromEntries(
        Object.values(updates).map((v, i) => [`:v${i}`, v]),
      );

      const result = await ddb.send(
        new UpdateCommand({
          TableName: GOALS_TABLE,
          Key: { userId, goalId },
          ConditionExpression: 'attribute_exists(goalId)',
          UpdateExpression: `SET ${expr}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: vals,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return ok(result.Attributes);
    }

    // DELETE /goals/{goalId}
    if (method === 'DELETE' && goalId) {
      await ddb.send(
        new DeleteCommand({ TableName: GOALS_TABLE, Key: { userId, goalId } }),
      );
      return ok({}, 204);
    }

    return err('Not found', 404);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'ConditionalCheckFailedException') {
      return err('Goal not found', 404);
    }
    console.error(e);
    return err('Internal server error', 500);
  }
};
