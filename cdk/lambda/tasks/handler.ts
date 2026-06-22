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

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
);

const TASKS_TABLE         = process.env.TASKS_TABLE!;
const USERS_TABLE         = process.env.USERS_TABLE!;
const GROUP_MEMBERS_TABLE = process.env.GROUP_MEMBERS_TABLE!;
const ACTIVITIES_TABLE    = process.env.ACTIVITIES_TABLE!;
const ALLOWED_ORIGIN      = process.env.ALLOWED_ORIGIN ?? '*';

// Base points per category, mirroring the original GAS logic
const BASE_POINTS: Record<string, number> = {
  exercise: 5,
  diet: 3,
  sleep: 7,
};

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

/** Create activity entries in each of the user's groups (fire-and-forget) */
async function createActivityForGroups(
  userId: string,
  fullName: string,
  title: string,
  taskType: string,
  points: number,
): Promise<void> {
  const membershipsRes = await ddb.send(
    new QueryCommand({
      TableName: GROUP_MEMBERS_TABLE,
      IndexName: 'UserGroupsIndex',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    }),
  );
  const groupIds = (membershipsRes.Items ?? []).map((m) => m.groupId as string);
  if (!groupIds.length) return;

  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const activityId = `${now.toISOString()}-${Math.random().toString(36).slice(2, 9)}`;

  await Promise.all(
    groupIds.map((groupId) =>
      ddb.send(
        new PutCommand({
          TableName: ACTIVITIES_TABLE,
          Item: {
            groupId,
            activityId,
            userId,
            fullName,
            activityType: 'task_complete',
            title,
            taskType,
            points,
            reactions: {},
            createdAt: now.toISOString(),
            ttl,
          },
        }),
      ),
    ),
  );
}

function calcPoints(
  type: string,
  weeklyStats: Record<string, number>,
  userPrefs: Record<string, unknown>,
): number {
  let pts = BASE_POINTS[type] ?? 5;

  // Boost points for the category with lowest weekly completion
  const rate = weeklyStats[type] ?? 1;
  if (rate < 0.4) pts = Math.min(100, Math.round(pts * 1.5));
  else if (rate < 0.7) pts = Math.min(100, Math.round(pts * 1.2));

  // Profile-based bonuses
  if (type === 'exercise' && userPrefs.exerciseIntensity === 'high') pts += 2;
  if (type === 'sleep') {
    const target = (userPrefs.sleepTarget as number) ?? 8;
    if (target >= 9) pts += 3;
    else if (target >= 8) pts += 2;
    else if (target >= 7) pts += 1;
  }

  return pts;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  const method = event.httpMethod;
  const taskId = event.pathParameters?.taskId;

  try {
    // GET /tasks?date=YYYY-MM-DD&week=YYYY-MM-DD
    if (method === 'GET') {
      const { date, week } = event.queryStringParameters ?? {};

      if (date) {
        const result = await ddb.send(
          new QueryCommand({
            TableName: TASKS_TABLE,
            IndexName: 'DateIndex',
            KeyConditionExpression: 'userId = :uid AND #d = :date',
            ExpressionAttributeNames: { '#d': 'date' },
            ExpressionAttributeValues: { ':uid': userId, ':date': date },
          }),
        );
        return ok(result.Items ?? []);
      }

      if (week) {
        // Return all tasks from the given week start (7 days)
        const weekEnd = new Date(week);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const result = await ddb.send(
          new QueryCommand({
            TableName: TASKS_TABLE,
            IndexName: 'DateIndex',
            KeyConditionExpression: 'userId = :uid AND #d BETWEEN :start AND :end',
            ExpressionAttributeNames: { '#d': 'date' },
            ExpressionAttributeValues: {
              ':uid': userId,
              ':start': week,
              ':end': weekEnd.toISOString().split('T')[0],
            },
          }),
        );
        return ok(result.Items ?? []);
      }

      // All tasks for user
      const result = await ddb.send(
        new QueryCommand({
          TableName: TASKS_TABLE,
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': userId },
        }),
      );
      return ok(result.Items ?? []);
    }

    // POST /tasks
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.title || !body.type) return err('title and type are required');

      // Compute weekly stats for dynamic point calculation
      const today = new Date();
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - today.getDay());
      const weekStr = startOfWeek.toISOString().split('T')[0];

      const [weeklyRes, userRes] = await Promise.all([
        ddb.send(
          new QueryCommand({
            TableName: TASKS_TABLE,
            IndexName: 'DateIndex',
            KeyConditionExpression: 'userId = :uid AND #d >= :week',
            ExpressionAttributeNames: { '#d': 'date' },
            ExpressionAttributeValues: { ':uid': userId, ':week': weekStr },
          }),
        ),
        ddb.send(
          new QueryCommand({
            TableName: USERS_TABLE,
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: { ':uid': userId },
            Limit: 1,
          }),
        ),
      ]);

      const weeklyItems = weeklyRes.Items ?? [];
      const weeklyStats: Record<string, number> = {};
      for (const type of ['exercise', 'diet', 'sleep']) {
        const total = weeklyItems.filter((t) => t.type === type).length;
        const done = weeklyItems.filter((t) => t.type === type && t.completed).length;
        weeklyStats[type] = total > 0 ? done / total : 1;
      }

      const userPrefs = userRes.Items?.[0] ?? {};
      const points = body.points ?? calcPoints(body.type, weeklyStats, userPrefs);

      const task = {
        userId,
        taskId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        title: body.title as string,
        type: body.type as string,
        points,
        completed: false,
        date: (body.date as string) ?? new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: TASKS_TABLE, Item: task }));
      return ok(task, 201);
    }

    // PUT /tasks/{taskId}
    if (method === 'PUT' && taskId) {
      const body = JSON.parse(event.body ?? '{}');
      const allowed = ['title', 'completed', 'points', 'date'];
      const updates = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k)),
      );
      if (!Object.keys(updates).length) return err('No valid fields to update');

      const completingNow = updates.completed === true;

      // Award XP when completing a task
      if (completingNow) {
        updates.completedAt = new Date().toISOString();
      }

      const keys = Object.keys(updates);
      const expr = keys.map((k, i) => `#k${i} = :v${i}`).join(', ');
      const names = Object.fromEntries(keys.map((k, i) => [`#k${i}`, k]));
      const vals = Object.fromEntries(
        Object.values(updates).map((v, i) => [`:v${i}`, v]),
      );

      const result = await ddb.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression: `SET ${expr}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: vals,
          ReturnValues: 'ALL_NEW',
        }),
      );

      // Create activity feed entry if task was just completed and user is public
      if (completingNow) {
        const taskItem = result.Attributes;
        const userRes = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
        if (userRes.Item?.isTaskPublic && taskItem) {
          const fullName = (userRes.Item?.fullName as string) ?? 'ユーザー';
          createActivityForGroups(
            userId,
            fullName,
            taskItem.title as string,
            taskItem.type as string,
            (taskItem.points as number) ?? 0,
          ).catch((e) => console.warn('[activity] task complete failed:', e));
        }
      }

      return ok(result.Attributes);
    }

    // DELETE /tasks/{taskId}
    if (method === 'DELETE' && taskId) {
      await ddb.send(
        new DeleteCommand({ TableName: TASKS_TABLE, Key: { userId, taskId } }),
      );
      return ok({}, 204);
    }

    return err('Not found', 404);
  } catch (e) {
    console.error(e);
    return err('Internal server error', 500);
  }
};
