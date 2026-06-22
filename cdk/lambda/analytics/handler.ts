import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
);

const USERS_TABLE          = process.env.USERS_TABLE!;
const TASKS_TABLE          = process.env.TASKS_TABLE!;
const HABITS_TABLE         = process.env.HABITS_TABLE!;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN ?? '*';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
};

function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(body) };
}
function forbidden(): APIGatewayProxyResult {
  return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ message: 'admin または analyst ロールが必要です' }) };
}
function serverError(): APIGatewayProxyResult {
  return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ message: 'Internal server error' }) };
}

/** Cognito authorizer passes array claims as comma-separated strings */
function getGroups(event: APIGatewayProxyEvent): string[] {
  const raw = (event.requestContext.authorizer?.claims?.['cognito:groups'] ?? '') as string;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // Authorization: admin or analyst only
  const groups = getGroups(event);
  if (!groups.includes('admin') && !groups.includes('analyst')) {
    return forbidden();
  }

  try {
    // Scan all three tables in parallel (PAY_PER_REQUEST, data volume is small)
    const [usersRes, tasksRes, habitsRes] = await Promise.all([
      ddb.send(new ScanCommand({ TableName: USERS_TABLE })),
      ddb.send(new ScanCommand({ TableName: TASKS_TABLE })),
      ddb.send(new ScanCommand({ TableName: HABITS_TABLE })),
    ]);

    const users  = usersRes.Items  ?? [];
    const tasks  = tasksRes.Items  ?? [];
    const habits = habitsRes.Items ?? [];

    // ---- Summary stats ----
    const totalUsers     = users.length;
    const totalTasks     = tasks.length;
    const completedTasks = tasks.filter((t) => t.completed).length;
    const completionRate = totalTasks > 0
      ? Math.round((completedTasks / totalTasks) * 100)
      : 0;
    const totalHabits = habits.length;

    // Last 7 days window
    const now       = new Date();
    const weekAgo   = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];
    const weekTasks  = tasks.filter((t) => (t.date as string) >= weekAgoStr);

    // ---- Tasks by category ----
    const tasksByType: Record<string, { total: number; completed: number }> = {};
    for (const t of tasks) {
      const type = (t.type as string) || 'unknown';
      if (!tasksByType[type]) tasksByType[type] = { total: 0, completed: 0 };
      tasksByType[type].total++;
      if (t.completed) tasksByType[type].completed++;
    }

    // ---- Daily activity (last 30 days) ----
    const dailyMap: Record<string, { total: number; completed: number }> = {};
    const thirtyAgo    = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirtyAgoStr = thirtyAgo.toISOString().split('T')[0];
    for (const t of tasks) {
      const d = t.date as string;
      if (d < thirtyAgoStr) continue;
      if (!dailyMap[d]) dailyMap[d] = { total: 0, completed: 0 };
      dailyMap[d].total++;
      if (t.completed) dailyMap[d].completed++;
    }
    const dailyActivity = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));

    // ---- Per-user ranking ----
    const userRanking = users.map((u) => {
      const uid        = u.userId as string;
      const userTasks  = tasks.filter((t) => t.userId === uid);
      const userCompleted = userTasks.filter((t) => t.completed).length;
      const userWeekTasks = userTasks.filter((t) => (t.date as string) >= weekAgoStr);
      const weekCompleted = userWeekTasks.filter((t) => t.completed).length;
      const userHabits = habits.filter((h) => h.userId === uid);

      // Simplified week points: sum task.points for completed week tasks
      const weekPoints = userWeekTasks
        .filter((t) => t.completed)
        .reduce((s, t) => s + ((t.points as number) || 5), 0);

      return {
        userId:         uid,
        fullName:       (u.fullName as string) ?? '',
        email:          (u.email as string) ?? '',
        totalTasks:     userTasks.length,
        completedTasks: userCompleted,
        weekPoints,
        weekCompleted,
        habitCount:     userHabits.length,
        level:          (u.level as number) ?? 1,
      };
    }).sort((a, b) => b.weekPoints - a.weekPoints);

    return ok({
      summary: {
        totalUsers,
        totalTasks,
        completedTasks,
        completionRate,
        totalHabits,
        weekTasks: weekTasks.length,
        weekCompleted: weekTasks.filter((t) => t.completed).length,
      },
      tasksByType,
      dailyActivity,
      userRanking,
      generatedAt: now.toISOString(),
    });
  } catch (e) {
    console.error('analytics handler error:', e);
    return serverError();
  }
};
