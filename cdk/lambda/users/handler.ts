import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
);

const USERS_TABLE    = process.env.USERS_TABLE!;
const TASKS_TABLE    = process.env.TASKS_TABLE!;
const HABITS_TABLE   = process.env.HABITS_TABLE!;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';

const BADGE_RULES = [
  { key: 'first', label: '初めの一歩', emoji: '🌟', check: (s: Stats) => s.totalTasks >= 1 },
  { key: 'dedicated', label: '頑張り屋', emoji: '💪', check: (s: Stats) => s.totalTasks >= 5 },
  { key: 'champion', label: 'チャンピオン', emoji: '👑', check: (s: Stats) => s.totalTasks >= 10 },
  { key: 'week_100', label: '完璧な週', emoji: '🔥', check: (s: Stats) => s.weeklyRate >= 100 },
  { key: 'habit_starter', label: '習慣スターター', emoji: '🌱', check: (s: Stats) => s.habitCount >= 3 },
];

interface Stats {
  totalTasks: number;
  weeklyRate: number;
  habitCount: number;
}

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

async function getOrCreateUser(userId: string, email: string, name: string) {
  const existing = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } }),
  );
  if (existing.Item) return existing.Item;

  const user = {
    userId,
    email,
    fullName: name,
    level: 1,
    totalExp: 0,
    totalPoints: 0,
    badges: [] as string[],
    isTaskPublic: false,
    weeklyGoal: 7,
    exerciseIntensity: 'medium',
    sleepTarget: 8,
    dietGoal: 'balance',
    lifePattern: 'both',
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: user }));
  return user;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  const claims = event.requestContext.authorizer?.claims ?? {};
  const resource = event.resource;
  const method = event.httpMethod;

  try {
    // GET /users/me
    if (method === 'GET' && resource === '/users/me') {
      const user = await getOrCreateUser(userId, claims.email, claims.name ?? '');
      return ok(user);
    }

    // PUT /users/me
    if (method === 'PUT' && resource === '/users/me') {
      const body = JSON.parse(event.body ?? '{}');
      const allowed = [
        'fullName', 'weeklyGoal', 'exerciseIntensity',
        'sleepTarget', 'dietGoal', 'lifePattern', 'isTaskPublic', 'goal',
      ];
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
          TableName: USERS_TABLE,
          Key: { userId },
          UpdateExpression: `SET ${expr}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: vals,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return ok(result.Attributes);
    }

    // GET /users/me/badges
    if (method === 'GET' && resource === '/users/me/badges') {
      // Gather stats
      const [taskRes, habitRes, userRes] = await Promise.all([
        ddb.send(
          new QueryCommand({
            TableName: TASKS_TABLE,
            KeyConditionExpression: 'userId = :uid',
            FilterExpression: 'completed = :t',
            ExpressionAttributeValues: { ':uid': userId, ':t': true },
          }),
        ),
        ddb.send(
          new QueryCommand({
            TableName: HABITS_TABLE,
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: { ':uid': userId },
          }),
        ),
        ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } })),
      ]);

      const totalTasks = taskRes.Count ?? 0;
      const habitCount = habitRes.Count ?? 0;
      const weeklyGoal = (userRes.Item?.weeklyGoal as number) ?? 7;

      // Weekly completion rate
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      const weekStr = startOfWeek.toISOString().split('T')[0];
      const weeklyTasks = (taskRes.Items ?? []).filter(
        (t) => (t.date as string) >= weekStr,
      );
      const weeklyRate =
        weeklyGoal > 0
          ? Math.round((weeklyTasks.filter((t) => t.completed).length / weeklyGoal) * 100)
          : 0;

      const stats: Stats = { totalTasks, weeklyRate, habitCount };
      const earned = BADGE_RULES.filter((r) => r.check(stats)).map((r) => ({
        key: r.key,
        label: r.label,
        emoji: r.emoji,
      }));

      // Persist newly earned badges
      const current = (userRes.Item?.badges as string[]) ?? [];
      const newBadges = earned.map((b) => b.key).filter((k) => !current.includes(k));
      if (newBadges.length) {
        await ddb.send(
          new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { userId },
            UpdateExpression: 'SET badges = :b',
            ExpressionAttributeValues: { ':b': [...current, ...newBadges] },
          }),
        );
      }

      return ok(earned);
    }

    return err('Not found', 404);
  } catch (e) {
    console.error(e);
    return err('Internal server error', 500);
  }
};
