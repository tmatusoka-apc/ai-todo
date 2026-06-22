#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SecurityStack } from '../lib/security-stack';
import { InfraStack } from '../lib/infra-stack';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

const securityStack = new SecurityStack(app, 'AiTodoSecurityStack', {
  env,
  description: 'AI Todo – Cognito, IAM roles, Secrets Manager',
});

const infraStack = new InfraStack(app, 'AiTodoInfraStack', {
  env,
  description: 'AI Todo – DynamoDB tables',
});

const appStack = new AppStack(app, 'AiTodoAppStack', {
  env,
  description: 'AI Todo – Lambda, API Gateway, CloudFront',
  userPool: securityStack.userPool,
  userPoolClient: securityStack.userPoolClient,
  lambdaExecutionRole: securityStack.lambdaExecutionRole,
  geminiApiKeySecret: securityStack.geminiApiKeySecret,
  usersTable: infraStack.usersTable,
  tasksTable: infraStack.tasksTable,
  habitsTable: infraStack.habitsTable,
  groupsTable: infraStack.groupsTable,
  groupMembersTable: infraStack.groupMembersTable,
  goalsTable: infraStack.goalsTable,
  activitiesTable: infraStack.activitiesTable,
  wlWeightLogsTable: infraStack.wlWeightLogsTable,
  wlKnowledgeTable: infraStack.wlKnowledgeTable,
  wlTodosTable: infraStack.wlTodosTable,
});

appStack.addDependency(securityStack);
appStack.addDependency(infraStack);

// Cost allocation tags applied to all resources
cdk.Tags.of(app).add('Project', 'ai-todo');
cdk.Tags.of(app).add('Env', 'prod');
cdk.Tags.of(app).add('ManagedBy', 'cdk');
