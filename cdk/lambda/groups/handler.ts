import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
);

const GROUPS_TABLE        = process.env.GROUPS_TABLE!;
const GROUP_MEMBERS_TABLE = process.env.GROUP_MEMBERS_TABLE!;
const TASKS_TABLE         = process.env.TASKS_TABLE!;
const USERS_TABLE         = process.env.USERS_TABLE!;
const ACTIVITIES_TABLE    = process.env.ACTIVITIES_TABLE!;
const ALLOWED_ORIGIN      = process.env.ALLOWED_ORIGIN ?? '*';

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

function weekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().split('T')[0];
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  const method = event.httpMethod;
  const groupId = event.pathParameters?.groupId;
  const resource = event.resource;

  try {
    // GET /groups – list groups the current user belongs to
    if (method === 'GET' && !groupId) {
      const memberships = await ddb.send(
        new QueryCommand({
          TableName: GROUP_MEMBERS_TABLE,
          IndexName: 'UserGroupsIndex',
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': userId },
        }),
      );

      const groupIds = (memberships.Items ?? []).map((m) => m.groupId as string);
      if (!groupIds.length) return ok([]);

      const groups = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [GROUPS_TABLE]: {
              Keys: groupIds.map((id) => ({ groupId: id })),
            },
          },
        }),
      );

      return ok(groups.Responses?.[GROUPS_TABLE] ?? []);
    }

    // POST /groups – create a new group
    if (method === 'POST' && !groupId) {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return err('name is required');

      const newGroupId = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const group = {
        groupId: newGroupId,
        name: body.name as string,
        description: (body.description as string) ?? '',
        ownerId: userId,
        createdAt: new Date().toISOString(),
      };

      const membership = {
        groupId: newGroupId,
        userId,
        joinedAt: new Date().toISOString(),
      };

      await Promise.all([
        ddb.send(new PutCommand({ TableName: GROUPS_TABLE, Item: group })),
        ddb.send(new PutCommand({ TableName: GROUP_MEMBERS_TABLE, Item: membership })),
      ]);

      return ok(group, 201);
    }

    // GET /groups/{groupId}
    if (method === 'GET' && groupId && !resource.includes('/members') && !resource.includes('/ranking')) {
      const [groupRes, membersRes] = await Promise.all([
        ddb.send(new GetCommand({ TableName: GROUPS_TABLE, Key: { groupId } })),
        ddb.send(
          new QueryCommand({
            TableName: GROUP_MEMBERS_TABLE,
            KeyConditionExpression: 'groupId = :gid',
            ExpressionAttributeValues: { ':gid': groupId },
          }),
        ),
      ]);

      if (!groupRes.Item) return err('Group not found', 404);

      return ok({ ...groupRes.Item, members: membersRes.Items ?? [] });
    }

    // DELETE /groups/{groupId}
    if (method === 'DELETE' && groupId && !resource.includes('/members')) {
      const group = await ddb.send(
        new GetCommand({ TableName: GROUPS_TABLE, Key: { groupId } }),
      );
      if (!group.Item) return err('Group not found', 404);
      if (group.Item.ownerId !== userId) return err('Only the owner can delete a group', 403);

      // Remove all members then delete group
      const members = await ddb.send(
        new QueryCommand({
          TableName: GROUP_MEMBERS_TABLE,
          KeyConditionExpression: 'groupId = :gid',
          ExpressionAttributeValues: { ':gid': groupId },
        }),
      );

      await Promise.all([
        ...(members.Items ?? []).map((m) =>
          ddb.send(
            new DeleteCommand({
              TableName: GROUP_MEMBERS_TABLE,
              Key: { groupId, userId: m.userId },
            }),
          ),
        ),
        ddb.send(new DeleteCommand({ TableName: GROUPS_TABLE, Key: { groupId } })),
      ]);

      return ok({}, 204);
    }

    // POST /groups/{groupId}/members – join group
    if (method === 'POST' && groupId && resource.endsWith('/members')) {
      const group = await ddb.send(
        new GetCommand({ TableName: GROUPS_TABLE, Key: { groupId } }),
      );
      if (!group.Item) return err('Group not found', 404);

      await ddb.send(
        new PutCommand({
          TableName: GROUP_MEMBERS_TABLE,
          Item: { groupId, userId, joinedAt: new Date().toISOString() },
          ConditionExpression: 'attribute_not_exists(userId)',
        }),
      );

      return ok({ groupId, userId });
    }

    // DELETE /groups/{groupId}/members – leave group
    if (method === 'DELETE' && groupId && resource.endsWith('/members')) {
      await ddb.send(
        new DeleteCommand({
          TableName: GROUP_MEMBERS_TABLE,
          Key: { groupId, userId },
        }),
      );
      return ok({}, 204);
    }

    // GET /groups/{groupId}/ranking – weekly leaderboard
    if (method === 'GET' && groupId && resource.endsWith('/ranking')) {
      const members = await ddb.send(
        new QueryCommand({
          TableName: GROUP_MEMBERS_TABLE,
          KeyConditionExpression: 'groupId = :gid',
          ExpressionAttributeValues: { ':gid': groupId },
        }),
      );

      const memberIds = (members.Items ?? []).map((m) => m.userId as string);
      if (!memberIds.length) return ok([]);

      // Fetch user names
      const usersRes = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [USERS_TABLE]: { Keys: memberIds.map((uid) => ({ userId: uid })) },
          },
        }),
      );
      const userMap = Object.fromEntries(
        (usersRes.Responses?.[USERS_TABLE] ?? []).map((u) => [
          u.userId as string,
          u.fullName as string,
        ]),
      );

      // Fetch this week's completed tasks for each member
      const ws = weekStart();
      const taskQueries = memberIds.map((uid) =>
        ddb.send(
          new QueryCommand({
            TableName: TASKS_TABLE,
            IndexName: 'DateIndex',
            KeyConditionExpression: 'userId = :uid AND #d >= :ws',
            FilterExpression: 'completed = :t',
            ExpressionAttributeNames: { '#d': 'date' },
            ExpressionAttributeValues: { ':uid': uid, ':ws': ws, ':t': true },
          }),
        ),
      );

      const taskResults = await Promise.all(taskQueries);
      const ranking = memberIds
        .map((uid, i) => ({
          userId: uid,
          fullName: userMap[uid] ?? 'Unknown',
          weeklyPoints: (taskResults[i].Items ?? []).reduce(
            (sum, t) => sum + ((t.points as number) ?? 0),
            0,
          ),
        }))
        .sort((a, b) => b.weeklyPoints - a.weeklyPoints)
        .map((r, idx) => ({ ...r, rank: idx + 1 }));

      return ok(ranking);
    }

    // GET /groups/{groupId}/feed – paginated activity feed (newest first)
    if (method === 'GET' && groupId && resource.endsWith('/feed')) {
      // Verify membership
      const memberCheck = await ddb.send(
        new GetCommand({ TableName: GROUP_MEMBERS_TABLE, Key: { groupId, userId } }),
      );
      if (!memberCheck.Item) return err('Not a member of this group', 403);

      const result = await ddb.send(
        new QueryCommand({
          TableName: ACTIVITIES_TABLE,
          KeyConditionExpression: 'groupId = :gid',
          ExpressionAttributeValues: { ':gid': groupId },
          ScanIndexForward: false, // newest first
          Limit: 30,
        }),
      );

      return ok(result.Items ?? []);
    }

    // POST /groups/{groupId}/feed/{activityId}/react – add/update reaction
    if (method === 'POST' && groupId && resource.endsWith('/react')) {
      const activityId = event.pathParameters?.activityId;
      if (!activityId) return err('activityId required');

      const body = JSON.parse(event.body ?? '{}');
      const reactionType: string = (body.type as string) ?? 'like'; // like | cheer | fire

      await ddb.send(
        new UpdateCommand({
          TableName: ACTIVITIES_TABLE,
          Key: { groupId, activityId },
          UpdateExpression: 'SET reactions.#uid = :rt',
          ExpressionAttributeNames: { '#uid': userId },
          ExpressionAttributeValues: { ':rt': reactionType },
        }),
      );

      return ok({ groupId, activityId, userId, reactionType });
    }

    // DELETE /groups/{groupId}/feed/{activityId}/unreact – remove reaction
    if (method === 'DELETE' && groupId && resource.endsWith('/unreact')) {
      const activityId = event.pathParameters?.activityId;
      if (!activityId) return err('activityId required');

      await ddb.send(
        new UpdateCommand({
          TableName: ACTIVITIES_TABLE,
          Key: { groupId, activityId },
          UpdateExpression: 'REMOVE reactions.#uid',
          ExpressionAttributeNames: { '#uid': userId },
        }),
      );

      return ok({ groupId, activityId, userId, removed: true });
    }

    return err('Not found', 404);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'ConditionalCheckFailedException') {
      return err('Already a member of this group', 409);
    }
    console.error(e);
    return err('Internal server error', 500);
  }
};
