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

const HABITS_TABLE        = process.env.HABITS_TABLE!;
const USERS_TABLE         = process.env.USERS_TABLE!;
const GROUP_MEMBERS_TABLE = process.env.GROUP_MEMBERS_TABLE!;
const ACTIVITIES_TABLE    = process.env.ACTIVITIES_TABLE!;
const ALLOWED_ORIGIN      = process.env.ALLOWED_ORIGIN ?? '*';

const DIFFICULTY_MULTIPLIER: Record<string, number> = {
  超簡単: 0.5,
  簡単: 1.0,
  普通: 1.5,
  難しい: 2.0,
  超難しい: 2.5,
};

const BASE_HABIT_XP = 5;

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

function calcStreak(completionDates: string[], todayStr: string): number {
  if (!completionDates.length) return 0;
  const sorted = [...completionDates].sort().reverse();
  let streak = 0;
  let cursor = new Date(todayStr);

  for (const d of sorted) {
    const date = new Date(d);
    const diff = Math.round(
      (cursor.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
    );
    // 2-day rule: up to 1 day gap is allowed
    if (diff <= 1) {
      streak++;
      cursor = date;
    } else {
      break;
    }
  }
  return streak;
}

function checkMilestones(streak: number, existingMilestones: string[]): string[] {
  const milestones = [...existingMilestones];
  if (streak >= 66 && !milestones.includes('66days')) milestones.push('66days');
  if (streak >= 100 && !milestones.includes('100days')) milestones.push('100days');
  return milestones;
}

/**
 * Compute resilience score based on gap events.
 * comebackSpeed score: ≤3d=10, ≤7d=7, ≤14d=4, ≤30d=2, >30d=1
 * Final: sum(speedPts) * (comebackCount / totalGaps) — max 100
 */
function calcResilienceScore(gapEvents: { gapDays: number }[]): number {
  if (!gapEvents.length) return 0;
  const totalGaps = gapEvents.length;

  // Speed points per comeback: faster return = higher score
  const speedPoints = gapEvents.reduce((sum, g) => {
    const d = g.gapDays;
    const pts = d <= 3 ? 10 : d <= 7 ? 7 : d <= 14 ? 4 : d <= 30 ? 2 : 1;
    return sum + pts;
  }, 0);

  // All gaps recorded are comebacks (gap > 1d = streak broken), so ratio = 1
  // Formula caps at 100, scaled by average speed
  return Math.min(100, Math.round(speedPoints / totalGaps) * 10);
}

/** Create activity entries in each of the user's groups */
async function createActivityForGroups(
  userId: string,
  fullName: string,
  activityType: 'habit_complete' | 'task_complete',
  title: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  // Find groups the user belongs to
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
            activityType,
            title,
            reactions: {},
            createdAt: now.toISOString(),
            ttl,
            ...extra,
          },
        }),
      ),
    ),
  );
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  const method = event.httpMethod;
  const habitId = event.pathParameters?.habitId;
  const resource = event.resource;

  try {
    // GET /habits
    if (method === 'GET') {
      const result = await ddb.send(
        new QueryCommand({
          TableName: HABITS_TABLE,
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': userId },
        }),
      );
      return ok(result.Items ?? []);
    }

    // POST /habits
    if (method === 'POST' && !habitId) {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.title || !body.difficulty || !body.category) {
        return err('title, difficulty, and category are required');
      }

      const habit = {
        userId,
        habitId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        title: body.title as string,
        difficulty: body.difficulty as string,
        category: body.category as string,
        templateId: (body.templateId as string) ?? null,
        anchorTask: (body.anchorTask as string) ?? null,
        streak: 0,
        startDate: new Date().toISOString().split('T')[0],
        lastCompletedDate: null,
        completionDates: [] as string[],
        milestones: [] as string[],
        gapEvents: [] as { date: string; gapDays: number }[],
        createdAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: HABITS_TABLE, Item: habit }));
      return ok(habit, 201);
    }

    // PUT /habits/{habitId}
    if (method === 'PUT' && habitId && !resource.endsWith('/complete')) {
      const body = JSON.parse(event.body ?? '{}');
      const allowed = ['title', 'difficulty', 'category', 'anchorTask'];
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
          TableName: HABITS_TABLE,
          Key: { userId, habitId },
          UpdateExpression: `SET ${expr}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: vals,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return ok(result.Attributes);
    }

    // POST /habits/{habitId}/complete
    if (method === 'POST' && habitId && resource.endsWith('/complete')) {
      const body = JSON.parse(event.body ?? '{}');
      const todayStr: string = (body.date as string) ?? new Date().toISOString().split('T')[0];

      // Fetch current habit + user in parallel
      const [habitRes, userRes] = await Promise.all([
        ddb.send(
          new QueryCommand({
            TableName: HABITS_TABLE,
            KeyConditionExpression: 'userId = :uid AND habitId = :hid',
            ExpressionAttributeValues: { ':uid': userId, ':hid': habitId },
            Limit: 1,
          }),
        ),
        ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } })),
      ]);

      const habit = habitRes.Items?.[0];
      if (!habit) return err('Habit not found', 404);

      const dates: string[] = habit.completionDates as string[];
      if (dates.includes(todayStr)) return err('Already completed today', 409);

      // --- Gap event detection ---
      const lastDate = habit.lastCompletedDate as string | null;
      const gapEvents: { date: string; gapDays: number }[] = (habit.gapEvents as { date: string; gapDays: number }[]) ?? [];
      let isComeback = false;

      if (lastDate) {
        const last = new Date(lastDate);
        const today = new Date(todayStr);
        const gapDays = Math.round(
          (today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24),
        );
        // Gap > 1 day means the streak was broken (matches calcStreak's diff <= 1 rule) — record a comeback
        if (gapDays > 1) {
          gapEvents.push({ date: todayStr, gapDays });
          isComeback = true;
        }
      }

      const newDates = [...dates, todayStr];
      const streak = calcStreak(newDates, todayStr);
      const milestones = checkMilestones(streak, habit.milestones as string[]);
      const xpEarned = Math.round(
        BASE_HABIT_XP * (DIFFICULTY_MULTIPLIER[habit.difficulty as string] ?? 1),
      );

      // --- Resilience score update ---
      const user = userRes.Item;
      const currentResilienceScore = (user?.resilienceScore as number) ?? 0;
      const comebackCount = gapEvents.length;
      const avgGapDays = comebackCount > 0
        ? Math.round(gapEvents.reduce((s, g) => s + g.gapDays, 0) / comebackCount)
        : 0;
      const newResilienceScore = calcResilienceScore(gapEvents);

      // Update habit and user in parallel
      const updateOps: Promise<unknown>[] = [
        ddb.send(
          new UpdateCommand({
            TableName: HABITS_TABLE,
            Key: { userId, habitId },
            UpdateExpression:
              'SET completionDates = :d, streak = :s, lastCompletedDate = :l, milestones = :m, gapEvents = :g',
            ExpressionAttributeValues: {
              ':d': newDates,
              ':s': streak,
              ':l': todayStr,
              ':m': milestones,
              ':g': gapEvents,
            },
            ReturnValues: 'ALL_NEW',
          }),
        ),
      ];

      // Update resilience score in users table if it changed
      if (newResilienceScore !== currentResilienceScore || isComeback) {
        updateOps.push(
          ddb.send(
            new UpdateCommand({
              TableName: USERS_TABLE,
              Key: { userId },
              UpdateExpression:
                'SET resilienceScore = :rs, comebackCount = :cc, avgGapDays = :ag',
              ExpressionAttributeValues: {
                ':rs': newResilienceScore,
                ':cc': comebackCount,
                ':ag': avgGapDays,
              },
            }),
          ),
        );
      }

      const [habitUpdateRes] = await Promise.all(updateOps);
      const updatedHabit = (habitUpdateRes as { Attributes?: unknown }).Attributes;

      // --- Activity feed creation (fire-and-forget if isTaskPublic) ---
      if (user?.isTaskPublic) {
        const fullName = (user?.fullName as string) ?? 'ユーザー';
        createActivityForGroups(userId, fullName, 'habit_complete', habit.title as string, {
          streak,
          isComeback,
          difficulty: habit.difficulty,
        }).catch((e) => console.warn('[activity] failed:', e));
      }

      return ok({ habit: updatedHabit, xpEarned, isComeback, resilienceScore: newResilienceScore });
    }

    // DELETE /habits/{habitId}
    if (method === 'DELETE' && habitId) {
      await ddb.send(
        new DeleteCommand({ TableName: HABITS_TABLE, Key: { userId, habitId } }),
      );
      return ok({}, 204);
    }

    return err('Not found', 404);
  } catch (e) {
    console.error(e);
    return err('Internal server error', 500);
  }
};
