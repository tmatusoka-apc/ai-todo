import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly tasksTable: dynamodb.Table;
  public readonly habitsTable: dynamodb.Table;
  public readonly groupsTable: dynamodb.Table;
  public readonly groupMembersTable: dynamodb.Table;
  public readonly goalsTable: dynamodb.Table;
  public readonly activitiesTable: dynamodb.Table;
  public readonly wlWeightLogsTable: dynamodb.Table;
  public readonly wlKnowledgeTable: dynamodb.Table;
  public readonly wlTodosTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------ //
    // DynamoDB – Users
    //   PK: userId (UUID)
    //   GSI: EmailIndex (email → userId) for login lookups
    // ------------------------------------------------------------------ //
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'ai-todo-users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'EmailIndex',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Tasks
    //   PK: userId, SK: taskId
    //   LSI: DateIndex (userId + date) for daily task queries
    // ------------------------------------------------------------------ //
    this.tasksTable = new dynamodb.Table(this, 'TasksTable', {
      tableName: 'ai-todo-tasks',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.tasksTable.addLocalSecondaryIndex({
      indexName: 'DateIndex',
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Habits
    //   PK: userId, SK: habitId
    // ------------------------------------------------------------------ //
    this.habitsTable = new dynamodb.Table(this, 'HabitsTable', {
      tableName: 'ai-todo-habits',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'habitId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Groups
    //   PK: groupId
    // ------------------------------------------------------------------ //
    this.groupsTable = new dynamodb.Table(this, 'GroupsTable', {
      tableName: 'ai-todo-groups',
      partitionKey: { name: 'groupId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Group Members
    //   PK: groupId, SK: userId
    //   GSI: UserGroupsIndex (userId → groupId) to list a user's groups
    // ------------------------------------------------------------------ //
    this.groupMembersTable = new dynamodb.Table(this, 'GroupMembersTable', {
      tableName: 'ai-todo-group-members',
      partitionKey: { name: 'groupId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.groupMembersTable.addGlobalSecondaryIndex({
      indexName: 'UserGroupsIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Goals
    //   PK: userId, SK: goalId
    //   Stores user's medium/long-term goals with AI-generated backcast plan
    // ------------------------------------------------------------------ //
    this.goalsTable = new dynamodb.Table(this, 'GoalsTable', {
      tableName: 'ai-todo-goals',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'goalId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Activities (Group Activity Feed)
    //   PK: groupId, SK: activityId (timestamp#uuid for time-sorted retrieval)
    //   TTL: ttl attribute (Unix epoch, 30 days)
    // ------------------------------------------------------------------ //
    this.activitiesTable = new dynamodb.Table(this, 'ActivitiesTable', {
      tableName: 'ai-todo-activities',
      partitionKey: { name: 'groupId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'activityId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Weight Loss: Weight Logs
    //   PK: userId, SK: date (YYYY-MM-DD)
    // ------------------------------------------------------------------ //
    this.wlWeightLogsTable = new dynamodb.Table(this, 'WlWeightLogsTable', {
      tableName: 'ai-todo-wl-weight-logs',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Weight Loss: Knowledge Base
    //   PK: userId, SK: knowledgeId
    // ------------------------------------------------------------------ //
    this.wlKnowledgeTable = new dynamodb.Table(this, 'WlKnowledgeTable', {
      tableName: 'ai-todo-wl-knowledge',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'knowledgeId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------ //
    // DynamoDB – Weight Loss: Todos
    //   PK: userId, SK: todoId
    //   LSI: DateIndex (userId + date)
    // ------------------------------------------------------------------ //
    this.wlTodosTable = new dynamodb.Table(this, 'WlTodosTable', {
      tableName: 'ai-todo-wl-todos',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.wlTodosTable.addLocalSecondaryIndex({
      indexName: 'DateIndex',
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ------------------------------------------------------------------ //
    // Outputs
    // ------------------------------------------------------------------ //
    new cdk.CfnOutput(this, 'UsersTableName', {
      value: this.usersTable.tableName,
      exportName: 'AiTodoUsersTable',
    });
    new cdk.CfnOutput(this, 'TasksTableName', {
      value: this.tasksTable.tableName,
      exportName: 'AiTodoTasksTable',
    });
    new cdk.CfnOutput(this, 'HabitsTableName', {
      value: this.habitsTable.tableName,
      exportName: 'AiTodoHabitsTable',
    });
    new cdk.CfnOutput(this, 'GroupsTableName', {
      value: this.groupsTable.tableName,
      exportName: 'AiTodoGroupsTable',
    });
    new cdk.CfnOutput(this, 'GroupMembersTableName', {
      value: this.groupMembersTable.tableName,
      exportName: 'AiTodoGroupMembersTable',
    });
    new cdk.CfnOutput(this, 'GoalsTableName', {
      value: this.goalsTable.tableName,
      exportName: 'AiTodoGoalsTable',
    });
    new cdk.CfnOutput(this, 'ActivitiesTableName', {
      value: this.activitiesTable.tableName,
      exportName: 'AiTodoActivitiesTable',
    });
    new cdk.CfnOutput(this, 'WlWeightLogsTableName', {
      value: this.wlWeightLogsTable.tableName,
      exportName: 'AiTodoWlWeightLogsTable',
    });
    new cdk.CfnOutput(this, 'WlKnowledgeTableName', {
      value: this.wlKnowledgeTable.tableName,
      exportName: 'AiTodoWlKnowledgeTable',
    });
    new cdk.CfnOutput(this, 'WlTodosTableName', {
      value: this.wlTodosTable.tableName,
      exportName: 'AiTodoWlTodosTable',
    });
  }
}
