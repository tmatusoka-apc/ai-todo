import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AppStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  lambdaExecutionRole: iam.Role;
  geminiApiKeySecret: secretsmanager.Secret;
  usersTable: dynamodb.Table;
  tasksTable: dynamodb.Table;
  habitsTable: dynamodb.Table;
  groupsTable: dynamodb.Table;
  groupMembersTable: dynamodb.Table;
  goalsTable: dynamodb.Table;
  activitiesTable: dynamodb.Table;
  wlWeightLogsTable: dynamodb.Table;
  wlKnowledgeTable: dynamodb.Table;
  wlTodosTable: dynamodb.Table;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------ //
    // Common Lambda configuration
    // ------------------------------------------------------------------ //
    const commonEnv: Record<string, string> = {
      USERS_TABLE: props.usersTable.tableName,
      TASKS_TABLE: props.tasksTable.tableName,
      HABITS_TABLE: props.habitsTable.tableName,
      GROUPS_TABLE: props.groupsTable.tableName,
      GROUP_MEMBERS_TABLE: props.groupMembersTable.tableName,
      GOALS_TABLE: props.goalsTable.tableName,
      ACTIVITIES_TABLE: props.activitiesTable.tableName,
      WL_WEIGHT_LOGS_TABLE: props.wlWeightLogsTable.tableName,
      WL_KNOWLEDGE_TABLE: props.wlKnowledgeTable.tableName,
      WL_TODOS_TABLE: props.wlTodosTable.tableName,
      GEMINI_SECRET_ARN: props.geminiApiKeySecret.secretArn,
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
      REGION: this.region,
      NODE_OPTIONS: '--enable-source-maps',
      // ALLOWED_ORIGIN: injected from GitHub Secret CLOUDFRONT_URL on re-deploy.
      // Defaults to '*' when the secret is not set (first deploy or local).
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ?? '*',
    };

    const bundling: lambdaNodejs.BundlingOptions = {
      minify: true,
      sourceMap: true,
      // Use runtime-provided AWS SDK v3 (available in Node.js 20 runtime)
      externalModules: ['@aws-sdk/*'],
      target: 'es2020',
    };

    const lambdaDefaults: Omit<lambdaNodejs.NodejsFunctionProps, 'entry'> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      role: props.lambdaExecutionRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling,
    };

    // ------------------------------------------------------------------ //
    // Lambda Functions
    // ------------------------------------------------------------------ //
    const usersHandler = new lambdaNodejs.NodejsFunction(this, 'UsersHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-users',
      entry: path.join(__dirname, '../lambda/users/handler.ts'),
    });

    const tasksHandler = new lambdaNodejs.NodejsFunction(this, 'TasksHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-tasks',
      entry: path.join(__dirname, '../lambda/tasks/handler.ts'),
    });

    const habitsHandler = new lambdaNodejs.NodejsFunction(this, 'HabitsHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-habits',
      entry: path.join(__dirname, '../lambda/habits/handler.ts'),
    });

    const groupsHandler = new lambdaNodejs.NodejsFunction(this, 'GroupsHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-groups',
      entry: path.join(__dirname, '../lambda/groups/handler.ts'),
    });

    const aiHandler = new lambdaNodejs.NodejsFunction(this, 'AiHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-ai',
      entry: path.join(__dirname, '../lambda/ai/handler.ts'),
      timeout: cdk.Duration.seconds(60),
    });

    const analyticsHandler = new lambdaNodejs.NodejsFunction(this, 'AnalyticsHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-analytics',
      entry: path.join(__dirname, '../lambda/analytics/handler.ts'),
    });

    const goalsHandler = new lambdaNodejs.NodejsFunction(this, 'GoalsHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-goals',
      entry: path.join(__dirname, '../lambda/goals/handler.ts'),
      timeout: cdk.Duration.seconds(60), // Gemini backcast may take time
    });

    const weightLossHandler = new lambdaNodejs.NodejsFunction(this, 'WeightLossHandler', {
      ...lambdaDefaults,
      functionName: 'ai-todo-weight-loss',
      entry: path.join(__dirname, '../lambda/weight-loss/handler.ts'),
      timeout: cdk.Duration.seconds(60),
    });

    // ------------------------------------------------------------------ //
    // API Gateway
    // ------------------------------------------------------------------ //
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'ai-todo-api',
      description: 'AI Todo REST API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'v1',
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [props.userPool],
      authorizerName: 'ai-todo-cognito-authorizer',
    });

    const auth: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Helper: attach a Lambda to multiple HTTP methods on a resource
    const integrate = (fn: lambda.IFunction) =>
      new apigateway.LambdaIntegration(fn, { proxy: true });

    // ------------------------------------------------------------------ //
    // Routes: /users/me
    // ------------------------------------------------------------------ //
    const usersRoot = api.root.addResource('users');
    const meRes = usersRoot.addResource('me');
    meRes.addMethod('GET', integrate(usersHandler), auth);
    meRes.addMethod('PUT', integrate(usersHandler), auth);
    meRes.addResource('badges').addMethod('GET', integrate(usersHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /tasks
    // ------------------------------------------------------------------ //
    const tasksRoot = api.root.addResource('tasks');
    tasksRoot.addMethod('GET', integrate(tasksHandler), auth);
    tasksRoot.addMethod('POST', integrate(tasksHandler), auth);

    const taskRes = tasksRoot.addResource('{taskId}');
    taskRes.addMethod('PUT', integrate(tasksHandler), auth);
    taskRes.addMethod('DELETE', integrate(tasksHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /habits
    // ------------------------------------------------------------------ //
    const habitsRoot = api.root.addResource('habits');
    habitsRoot.addMethod('GET', integrate(habitsHandler), auth);
    habitsRoot.addMethod('POST', integrate(habitsHandler), auth);

    const habitRes = habitsRoot.addResource('{habitId}');
    habitRes.addMethod('PUT', integrate(habitsHandler), auth);
    habitRes.addMethod('DELETE', integrate(habitsHandler), auth);
    habitRes.addResource('complete').addMethod('POST', integrate(habitsHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /groups
    // ------------------------------------------------------------------ //
    const groupsRoot = api.root.addResource('groups');
    groupsRoot.addMethod('GET', integrate(groupsHandler), auth);
    groupsRoot.addMethod('POST', integrate(groupsHandler), auth);

    const groupRes = groupsRoot.addResource('{groupId}');
    groupRes.addMethod('GET', integrate(groupsHandler), auth);
    groupRes.addMethod('DELETE', integrate(groupsHandler), auth);

    const membersRes = groupRes.addResource('members');
    membersRes.addMethod('POST', integrate(groupsHandler), auth);
    membersRes.addMethod('DELETE', integrate(groupsHandler), auth);

    groupRes.addResource('ranking').addMethod('GET', integrate(groupsHandler), auth);

    const feedRes = groupRes.addResource('feed');
    feedRes.addMethod('GET', integrate(groupsHandler), auth);
    const feedItemRes = feedRes.addResource('{activityId}');
    feedItemRes.addResource('react').addMethod('POST', integrate(groupsHandler), auth);
    feedItemRes.addResource('unreact').addMethod('DELETE', integrate(groupsHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /goals
    // ------------------------------------------------------------------ //
    const goalsRoot = api.root.addResource('goals');
    goalsRoot.addMethod('GET', integrate(goalsHandler), auth);
    goalsRoot.addMethod('POST', integrate(goalsHandler), auth);

    const goalRes = goalsRoot.addResource('{goalId}');
    goalRes.addMethod('PUT', integrate(goalsHandler), auth);
    goalRes.addMethod('DELETE', integrate(goalsHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /ai  (Cognito auth required to prevent cost abuse)
    // ------------------------------------------------------------------ //
    const aiRoot = api.root.addResource('ai');
    aiRoot.addResource('suggestion').addMethod('POST', integrate(aiHandler), auth);
    aiRoot.addResource('suggestions').addMethod('POST', integrate(aiHandler), auth);
    aiRoot.addResource('backcast').addMethod('POST', integrate(goalsHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /analytics  (admin / analyst only – checked in Lambda)
    // ------------------------------------------------------------------ //
    const analyticsRoot = api.root.addResource('analytics');
    analyticsRoot.addResource('summary').addMethod('GET', integrate(analyticsHandler), auth);

    // ------------------------------------------------------------------ //
    // Routes: /wl  (Weight Loss – Cognito auth required)
    // ------------------------------------------------------------------ //
    const wlRoot = api.root.addResource('wl');

    wlRoot.addResource('dashboard').addMethod('GET', integrate(weightLossHandler), auth);

    const wlWeightLogs = wlRoot.addResource('weight-logs');
    wlWeightLogs.addMethod('GET', integrate(weightLossHandler), auth);
    wlWeightLogs.addMethod('POST', integrate(weightLossHandler), auth);
    wlWeightLogs.addResource('{date}').addMethod('DELETE', integrate(weightLossHandler), auth);

    const wlTodos = wlRoot.addResource('todos');
    wlTodos.addMethod('GET', integrate(weightLossHandler), auth);
    wlTodos.addMethod('POST', integrate(weightLossHandler), auth);
    const wlTodoRes = wlTodos.addResource('{todoId}');
    wlTodoRes.addMethod('PUT', integrate(weightLossHandler), auth);
    wlTodoRes.addMethod('DELETE', integrate(weightLossHandler), auth);

    const wlKnowledge = wlRoot.addResource('knowledge');
    wlKnowledge.addMethod('GET', integrate(weightLossHandler), auth);
    wlKnowledge.addMethod('POST', integrate(weightLossHandler), auth);
    const wlKnowledgeRes = wlKnowledge.addResource('{knowledgeId}');
    wlKnowledgeRes.addMethod('PUT', integrate(weightLossHandler), auth);
    wlKnowledgeRes.addMethod('DELETE', integrate(weightLossHandler), auth);

    wlRoot.addResource('chat').addMethod('POST', integrate(weightLossHandler), auth);

    const wlProfile = wlRoot.addResource('profile');
    wlProfile.addMethod('GET', integrate(weightLossHandler), auth);
    wlProfile.addMethod('PUT', integrate(weightLossHandler), auth);

    // ------------------------------------------------------------------ //
    // Mock Gemini stub – POST /mock/gemini/generateContent
    // Switch on by setting stubEndpoint in ai-todo/gemini-api-key secret:
    //   { "apiKey": "dummy", "stubEndpoint": "<apiUrl>/mock/gemini/generateContent" }
    // Switch off by removing / emptying stubEndpoint.
    // ------------------------------------------------------------------ //
    const mockGeminiResponse = JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '[STUB] これはテスト用スタブの回答です。Gemini APIは呼び出されていません。' }] },
      }],
    });
    const mockRoot = api.root.addResource('mock');
    mockRoot
      .addResource('gemini')
      .addResource('generateContent')
      .addMethod(
        'POST',
        new apigateway.MockIntegration({
          requestTemplates: { 'application/json': '{"statusCode":200}' },
          integrationResponses: [{
            statusCode: '200',
            responseTemplates: { 'application/json': mockGeminiResponse },
          }],
        }),
        {
          methodResponses: [{
            statusCode: '200',
            responseModels: { 'application/json': apigateway.Model.EMPTY_MODEL },
          }],
        },
      );

    // ------------------------------------------------------------------ //
    // S3 – Frontend bucket (moved here from InfraStack to avoid cross-stack
    //       circular dependency with CloudFront OAC bucket policy)
    // ------------------------------------------------------------------ //
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `ai-todo-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      exportName: 'AiTodoFrontendBucket',
    });

    // ------------------------------------------------------------------ //
    // CloudFront Distribution
    //   Default: S3 (SPA frontend)
    //   /v1/*:  API Gateway (Lambda proxy)
    // ------------------------------------------------------------------ //
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(
      frontendBucket,
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'AI Todo – SPA + API',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      additionalBehaviors: {
        '/v1/*': {
          origin: new origins.RestApiOrigin(api, { originPath: '/' }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ------------------------------------------------------------------ //
    // Outputs
    // ------------------------------------------------------------------ //
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      exportName: 'AiTodoApiEndpoint',
    });
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      exportName: 'AiTodoCloudFrontUrl',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      exportName: 'AiTodoDistributionId',
    });
  }
}
