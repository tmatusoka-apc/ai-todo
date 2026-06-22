import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.REGION }));
const sm = new SecretsManagerClient({ region: process.env.REGION });

const WL_WEIGHT_LOGS_TABLE = process.env.WL_WEIGHT_LOGS_TABLE!;
const WL_KNOWLEDGE_TABLE   = process.env.WL_KNOWLEDGE_TABLE!;
const WL_TODOS_TABLE       = process.env.WL_TODOS_TABLE!;
const USERS_TABLE          = process.env.USERS_TABLE!;
const GEMINI_SECRET_ARN    = process.env.GEMINI_SECRET_ARN!;
const GEMINI_MODEL         = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN ?? '*';

// ------------------------------------------------------------------ //
// Response helpers
// ------------------------------------------------------------------ //
function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
    body: JSON.stringify(body),
  };
}

function err(message: string, status = 400): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
    body: JSON.stringify({ message }),
  };
}

function getUserId(event: APIGatewayProxyEvent): string | null {
  return (event.requestContext.authorizer?.claims?.sub as string) ?? null;
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ------------------------------------------------------------------ //
// Gemini API helper
// ------------------------------------------------------------------ //
interface GeminiConfig { apiKey: string; url: string }
let cachedGeminiConfig: GeminiConfig | null = null;
let geminiConfigExpiry = 0;
const GEMINI_CONFIG_TTL_MS = 5 * 60 * 1000; // re-fetch secret every 5 minutes

async function getGeminiConfig(): Promise<GeminiConfig> {
  const now = Date.now();
  if (cachedGeminiConfig && now < geminiConfigExpiry) return cachedGeminiConfig;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: GEMINI_SECRET_ARN }));
  const secret = JSON.parse(res.SecretString ?? '{}') as { apiKey: string; stubEndpoint?: string };
  cachedGeminiConfig = {
    apiKey: secret.apiKey,
    // stubEndpoint in Secrets Manager overrides the real Gemini endpoint for testing
    url: secret.stubEndpoint
      ? secret.stubEndpoint
      : `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${secret.apiKey}`,
  };
  geminiConfigExpiry = now + GEMINI_CONFIG_TTL_MS;
  return cachedGeminiConfig;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt: string): Promise<string> {
  const { url: endpoint } = await getGeminiConfig();
  const reqBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody,
    });

    if (response.ok) {
      const data = await response.json() as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'すみません、回答を生成できませんでした。';
    }

    if (response.status === 429) {
      const errBody = await response.text().catch(() => '');
      // Quota exhaustion (RESOURCE_EXHAUSTED / credits depleted) → no point retrying
      if (errBody.includes('RESOURCE_EXHAUSTED') || errBody.includes('depleted') || errBody.includes('quota')) {
        throw new Error(`Gemini API error: 429 ${errBody.substring(0, 300)}`);
      }
      // Transient rate limit → retry with backoff
      if (attempt < 2) {
        const waitMs = Math.pow(5, attempt) * 1000; // 1s → 5s
        console.warn(`[callGemini] 429 rate limited, retry ${attempt + 1}/3 in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
    }

    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error: ${response.status} ${errBody.substring(0, 300)}`);
  }

  throw new Error('Gemini API error: max retries exceeded');
}

// ------------------------------------------------------------------ //
// Difficulty-aware starter todos
// ------------------------------------------------------------------ //
type Difficulty = 'beginner' | 'intermediate' | 'advanced';

function determineDifficulty(level: number, exerciseIntensity: string): Difficulty {
  if (level >= 16 || exerciseIntensity === 'high') return 'advanced';
  if (level >= 6  || exerciseIntensity === 'medium') return 'intermediate';
  return 'beginner';
}

function buildStarterTodos(difficulty: Difficulty, dietGoal: string, lifePattern: string) {
  const base = {
    beginner: [
      { title: '今日の体重を記録する',               category: '習慣' },
      { title: '水を6杯（1.2L）飲む',                category: '食事' },
      { title: '10〜15分の散歩をする',               category: '運動' },
      { title: '夜食を控える（21時以降は食べない）', category: '食事' },
      { title: '7時間以上睡眠を取る',                category: '習慣' },
    ],
    intermediate: [
      { title: '今日の体重・体脂肪率を記録する',           category: '習慣' },
      { title: '水を8杯（1.5L）飲む',                      category: '食事' },
      { title: '30分のウォーキングまたは軽いジョギング',   category: '運動' },
      { title: '間食を1回以内にする',                       category: '食事' },
      { title: '野菜を毎食1皿以上食べる',                  category: '食事' },
      { title: '7時間以上睡眠を取る',                       category: '習慣' },
    ],
    advanced: [
      { title: '体重・体脂肪率・筋肉量を記録する',                      category: '習慣' },
      { title: '水を2L飲む',                                             category: '食事' },
      { title: '45分以上の有酸素運動（ジョギング・サイクリング等）',    category: '運動' },
      { title: '筋トレ（スクワット・腕立て 20回×3セット）',             category: '運動' },
      { title: 'タンパク質を体重×1.6g以上摂取する',                     category: '食事' },
      { title: '精製糖質（白米・パン・菓子）を控える',                   category: '食事' },
      { title: '7時間以上睡眠を取る',                                    category: '習慣' },
    ],
  } as const;

  const todos = [...base[difficulty]];

  // dietGoal 別の追加タスク
  if (dietGoal === 'cut') {
    todos.push({ title: '1日の摂取カロリーを記録する', category: '食事' });
  } else if (dietGoal === 'bulk') {
    todos.push({ title: '高タンパク・高カロリーの食事を意識する', category: '食事' });
  }

  // lifePattern 別の追加タスク
  if (lifePattern === 'office') {
    todos.push({ title: '1時間に1回、席を立って軽くストレッチする', category: '運動' });
  } else if (lifePattern === 'remote') {
    todos.push({ title: '昼休みに10分外を歩く', category: '運動' });
  }

  return todos;
}

// ------------------------------------------------------------------ //
// Default starter kit todos (fallback)
// ------------------------------------------------------------------ //
const STARTER_TODOS = [
  { title: '今日の体重を記録する', category: '習慣' },
  { title: '水を8杯飲む', category: '食事' },
  { title: '20分ウォーキングする', category: '運動' },
  { title: '夜食を控える（21時以降は食べない）', category: '食事' },
  { title: '7時間以上睡眠を取る', category: '習慣' },
];

// ------------------------------------------------------------------ //
// Route handlers
// ------------------------------------------------------------------ //

// GET /wl/dashboard
async function getDashboard(userId: string): Promise<APIGatewayProxyResult> {
  const now = new Date();
  const todayStr = today();

  const [weightLogsRes, todayTodosRes, allKnowledgeRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: WL_WEIGHT_LOGS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
      Limit: 30,
    })),
    ddb.send(new QueryCommand({
      TableName: WL_TODOS_TABLE,
      IndexName: 'DateIndex',
      KeyConditionExpression: 'userId = :uid AND #d = :date',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':uid': userId, ':date': todayStr },
    })),
    ddb.send(new QueryCommand({
      TableName: WL_KNOWLEDGE_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      Select: 'COUNT',
    })),
  ]);

  const weightLogs = weightLogsRes.Items ?? [];
  const todayTodos = todayTodosRes.Items ?? [];
  const recentWeightLogs = weightLogs.slice(0, 7);

  // Calculate streak (consecutive days with weight logs)
  const logDates = new Set(weightLogs.map((l) => l.date as string));
  let streak = 0;
  const checkDate = new Date(now);
  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    if (logDates.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return ok({
    recentWeightLogs,
    todayTodoStats: {
      total: todayTodos.length,
      completed: todayTodos.filter((t) => t.completed).length,
    },
    streak,
    latestWeight: weightLogs[0]?.weight ?? null,
    recentKnowledgeCount: allKnowledgeRes.Count ?? 0,
  });
}

// GET /wl/weight-logs
async function getWeightLogs(userId: string, queryParams: Record<string, string>): Promise<APIGatewayProxyResult> {
  const limit = parseInt(queryParams?.limit ?? '30', 10);
  const result = await ddb.send(new QueryCommand({
    TableName: WL_WEIGHT_LOGS_TABLE,
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return ok(result.Items ?? []);
}

// POST /wl/weight-logs
async function postWeightLog(userId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  if (!body.date || body.weight === undefined) {
    return err('date and weight are required');
  }

  const weightNum = parseFloat(String(body.weight));
  if (isNaN(weightNum) || weightNum <= 0) {
    return err('weight must be a positive number');
  }

  // Try to get user height for BMI calculation
  let bmi: number | null = null;
  try {
    const userRes = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId },
    }));
    const heightCm = userRes.Item?.height as number | undefined;
    if (heightCm && heightCm > 0) {
      const heightM = heightCm / 100;
      bmi = parseFloat((weightNum / (heightM * heightM)).toFixed(1));
    }
  } catch (_e) {
    // height not available, skip BMI
  }

  const item: Record<string, unknown> = {
    userId,
    date: body.date as string,
    weight: weightNum,
    createdAt: new Date().toISOString(),
  };
  if (bmi !== null) item.bmi = bmi;
  if (body.memo) item.memo = body.memo as string;

  await ddb.send(new PutCommand({ TableName: WL_WEIGHT_LOGS_TABLE, Item: item }));
  return ok(item, 201);
}

// DELETE /wl/weight-logs/{date}
async function deleteWeightLog(userId: string, date: string): Promise<APIGatewayProxyResult> {
  await ddb.send(new DeleteCommand({
    TableName: WL_WEIGHT_LOGS_TABLE,
    Key: { userId, date },
  }));
  return ok({}, 204);
}

// GET /wl/todos
async function getTodos(userId: string, queryParams: Record<string, string>): Promise<APIGatewayProxyResult> {
  const dateFilter = queryParams?.date;
  let result;
  if (dateFilter) {
    result = await ddb.send(new QueryCommand({
      TableName: WL_TODOS_TABLE,
      IndexName: 'DateIndex',
      KeyConditionExpression: 'userId = :uid AND #d = :date',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':uid': userId, ':date': dateFilter },
    }));
  } else {
    result = await ddb.send(new QueryCommand({
      TableName: WL_TODOS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
    }));
  }

  const todayStr = today();
  const items = (result.Items ?? []).map((item) => {
    // Reset recurring todos if not completed today
    if (item.recurring && item.completed && item.completedDate !== todayStr) {
      return { ...item, completed: false };
    }
    return item;
  });

  return ok(items);
}

// POST /wl/todos
async function postTodo(userId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  const todayStr = today();

  // Starter kit: batch create difficulty-aware todos
  if (body.isTemplate === true) {
    // Fetch user profile to determine difficulty
    let templates = STARTER_TODOS;
    try {
      const userRes = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
      const u = userRes.Item ?? {};
      const level            = (u.level as number)            ?? 1;
      const exerciseIntensity = (u.exerciseIntensity as string) ?? 'medium';
      const dietGoal          = (u.dietGoal as string)          ?? 'balance';
      const lifePattern       = (u.lifePattern as string)       ?? 'both';
      const difficulty        = determineDifficulty(level, exerciseIntensity);
      templates = buildStarterTodos(difficulty, dietGoal, lifePattern);
    } catch (_e) {
      // fall back to default list
    }

    const items = templates.map((tmpl) => ({
      userId,
      todoId: genId(),
      title: tmpl.title,
      category: tmpl.category,
      completed: false,
      date: (body.date as string) ?? todayStr,
      createdAt: new Date().toISOString(),
    }));

    await Promise.all(items.map((item) =>
      ddb.send(new PutCommand({ TableName: WL_TODOS_TABLE, Item: item })),
    ));
    return ok(items, 201);
  }

  // Normal single todo creation
  if (!body.title || !body.category) {
    return err('title and category are required');
  }

  const item: Record<string, unknown> = {
    userId,
    todoId: genId(),
    title: body.title as string,
    category: body.category as string,
    completed: false,
    date: (body.date as string) ?? todayStr,
    createdAt: new Date().toISOString(),
  };
  if (body.recurring === true) item.recurring = true;

  await ddb.send(new PutCommand({ TableName: WL_TODOS_TABLE, Item: item }));
  return ok(item, 201);
}

// PUT /wl/todos/{todoId}
async function putTodo(userId: string, todoId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  const allowed = ['title', 'category', 'completed', 'date', 'recurring', 'completedDate'];
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

  const result = await ddb.send(new UpdateCommand({
    TableName: WL_TODOS_TABLE,
    Key: { userId, todoId },
    UpdateExpression: `SET ${expr}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
    ReturnValues: 'ALL_NEW',
  }));

  return ok(result.Attributes);
}

// DELETE /wl/todos/{todoId}
async function deleteTodo(userId: string, todoId: string): Promise<APIGatewayProxyResult> {
  await ddb.send(new DeleteCommand({
    TableName: WL_TODOS_TABLE,
    Key: { userId, todoId },
  }));
  return ok({}, 204);
}

// GET /wl/knowledge
async function getKnowledge(userId: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new QueryCommand({
    TableName: WL_KNOWLEDGE_TABLE,
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false,
  }));
  return ok(result.Items ?? []);
}

// POST /wl/knowledge
async function postKnowledge(userId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  if (!body.title || !body.content) {
    return err('title and content are required');
  }

  const now = new Date().toISOString();
  const item = {
    userId,
    knowledgeId: genId(),
    title: body.title as string,
    content: body.content as string,
    tags: Array.isArray(body.tags) ? body.tags as string[] : [],
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: WL_KNOWLEDGE_TABLE, Item: item }));
  return ok(item, 201);
}

// PUT /wl/knowledge/{knowledgeId}
async function putKnowledge(userId: string, knowledgeId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.content !== undefined) updates.content = body.content;
  if (body.tags !== undefined) updates.tags = body.tags;
  updates.updatedAt = new Date().toISOString();

  const keys = Object.keys(updates);
  const expr = keys.map((k, i) => `#k${i} = :v${i}`).join(', ');
  const names = Object.fromEntries(keys.map((k, i) => [`#k${i}`, k]));
  const vals = Object.fromEntries(
    Object.values(updates).map((v, i) => [`:v${i}`, v]),
  );

  const result = await ddb.send(new UpdateCommand({
    TableName: WL_KNOWLEDGE_TABLE,
    Key: { userId, knowledgeId },
    UpdateExpression: `SET ${expr}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
    ReturnValues: 'ALL_NEW',
  }));

  return ok(result.Attributes);
}

// DELETE /wl/knowledge/{knowledgeId}
async function deleteKnowledge(userId: string, knowledgeId: string): Promise<APIGatewayProxyResult> {
  await ddb.send(new DeleteCommand({
    TableName: WL_KNOWLEDGE_TABLE,
    Key: { userId, knowledgeId },
  }));
  return ok({}, 204);
}

// GET /wl/profile
async function getProfile(userId: string): Promise<APIGatewayProxyResult> {
  const res = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
  const item = res.Item ?? {};
  return ok({
    height: item.height ?? null,
    targetWeight: item.wlTargetWeight ?? null,
    targetDate: item.wlTargetDate ?? null,
  });
}

// PUT /wl/profile
async function putProfile(userId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  const height = body.height != null ? Number(body.height) : undefined;
  const targetWeight = body.targetWeight != null ? Number(body.targetWeight) : undefined;
  const targetDate = body.targetDate as string | undefined;

  const exprs: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (height !== undefined) { exprs.push('#h = :h'); names['#h'] = 'height'; values[':h'] = height; }
  if (targetWeight !== undefined) { exprs.push('#tw = :tw'); names['#tw'] = 'wlTargetWeight'; values[':tw'] = targetWeight; }
  if (targetDate !== undefined) { exprs.push('#td = :td'); names['#td'] = 'wlTargetDate'; values[':td'] = targetDate; }

  if (exprs.length === 0) return err('No fields to update');

  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId },
    UpdateExpression: `SET ${exprs.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
  return ok({ height, targetWeight, targetDate });
}

// POST /wl/chat  (RAG-lite chat with Gemini)
async function postChat(userId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  if (!body.message) return err('message is required');

  const userMessage = body.message as string;

  // Fetch user's knowledge base
  const knowledgeRes = await ddb.send(new QueryCommand({
    TableName: WL_KNOWLEDGE_TABLE,
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false,
  }));

  const allKnowledge = knowledgeRes.Items ?? [];

  // Simple keyword filter for relevance
  const keywords = userMessage
    .toLowerCase()
    .split(/[\s、。,]+/)
    .filter((w) => w.length > 1);

  let relevant = allKnowledge.filter((k) => {
    const text = `${k.title} ${k.content} ${(k.tags ?? []).join(' ')}`.toLowerCase();
    return keywords.some((kw) => text.includes(kw));
  });

  // Fallback: use latest 5 if no keyword match
  if (relevant.length === 0) {
    relevant = allKnowledge.slice(0, 5);
  } else {
    relevant = relevant.slice(0, 5);
  }

  // Build knowledge context string
  const knowledgeContext = relevant.length > 0
    ? relevant.map((k, i) =>
        `[${i + 1}] タイトル: ${k.title}\n内容: ${k.content}\nタグ: ${(k.tags ?? []).join(', ')}`,
      ).join('\n\n')
    : '（まだナレッジが登録されていません）';

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

  try {
    const reply = await callGemini(prompt);
    return ok({ reply });
  } catch (e) {
    console.error('[postChat] Gemini error:', e);
    return ok({ reply: 'AIサービスが一時的に利用できません。しばらく後にもう一度お試しください。' });
  }
}

// ------------------------------------------------------------------ //
// Main handler
// ------------------------------------------------------------------ //
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  if (!userId) return err('Unauthorized', 401);

  const method = event.httpMethod;
  const path = event.path;
  const params = event.pathParameters ?? {};
  const query = (event.queryStringParameters ?? {}) as Record<string, string>;

  let body: Record<string, unknown> = {};
  try {
    if (event.body) body = JSON.parse(event.body);
  } catch (_e) {
    return err('Invalid JSON body');
  }

  try {
    // GET /wl/dashboard
    if (method === 'GET' && path.endsWith('/wl/dashboard')) {
      return await getDashboard(userId);
    }

    // Weight Logs
    if (path.includes('/wl/weight-logs')) {
      const date = params.date;
      if (method === 'GET' && !date) return await getWeightLogs(userId, query);
      if (method === 'POST' && !date) return await postWeightLog(userId, body);
      if (method === 'DELETE' && date) return await deleteWeightLog(userId, date);
    }

    // Todos
    if (path.includes('/wl/todos')) {
      const todoId = params.todoId;
      if (method === 'GET' && !todoId) return await getTodos(userId, query);
      if (method === 'POST' && !todoId) return await postTodo(userId, body);
      if (method === 'PUT' && todoId) return await putTodo(userId, todoId, body);
      if (method === 'DELETE' && todoId) return await deleteTodo(userId, todoId);
    }

    // Knowledge
    if (path.includes('/wl/knowledge')) {
      const knowledgeId = params.knowledgeId;
      if (method === 'GET' && !knowledgeId) return await getKnowledge(userId);
      if (method === 'POST' && !knowledgeId) return await postKnowledge(userId, body);
      if (method === 'PUT' && knowledgeId) return await putKnowledge(userId, knowledgeId, body);
      if (method === 'DELETE' && knowledgeId) return await deleteKnowledge(userId, knowledgeId);
    }

    // Profile
    if (path.endsWith('/wl/profile')) {
      if (method === 'GET') return await getProfile(userId);
      if (method === 'PUT') return await putProfile(userId, body);
    }

    // Chat
    if (method === 'POST' && path.endsWith('/wl/chat')) {
      return await postChat(userId, body);
    }

    return err('Not found', 404);
  } catch (e) {
    console.error('[weight-loss] error:', e);
    return err('Internal server error', 500);
  }
};
