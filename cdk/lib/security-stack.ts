import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class SecurityStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly lambdaExecutionRole: iam.Role;
  public readonly geminiApiKeySecret: secretsmanager.Secret;
  public readonly allowedDomainSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------ //
    // Secrets Manager – Gemini API Key
    // ------------------------------------------------------------------ //
    this.geminiApiKeySecret = new secretsmanager.Secret(this, 'GeminiApiKeySecret', {
      secretName: 'ai-todo/gemini-api-key',
      description: 'Gemini API key. Optional stubEndpoint field switches to APIGW mock for testing.',
      // Production:  { "apiKey": "YOUR_REAL_KEY" }
      // Stub(test):  { "apiKey": "dummy", "stubEndpoint": "https://<api-id>.execute-api.<region>.amazonaws.com/v1/mock/gemini/generateContent" }
    });

    // ------------------------------------------------------------------ //
    // Secrets Manager – Allowed Sign-up Domain
    //   value: {"domain":"ap-com.co.jp"} to restrict, or {"domain":"anyone"}
    //   Updated by GitHub Actions after every deploy
    // ------------------------------------------------------------------ //
    this.allowedDomainSecret = new secretsmanager.Secret(this, 'AllowedDomainSecret', {
      secretName: 'ai-todo/allowed-domain',
      description: 'Allowed email domain for Cognito sign-up (anyone = open)',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ domain: 'ap-com.co.jp' }),
      ),
    });

    // ------------------------------------------------------------------ //
    // IAM – Pre-signup Lambda Execution Role (minimal permissions)
    // ------------------------------------------------------------------ //
    const preSignUpRole = new iam.Role(this, 'PreSignUpLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
      inlinePolicies: {
        SecretsManager: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: [this.allowedDomainSecret.secretArn],
            }),
          ],
        }),
      },
    });

    // ------------------------------------------------------------------ //
    // IAM – Post-confirmation Lambda Execution Role
    // ------------------------------------------------------------------ //
    const postConfirmationRole = new iam.Role(this, 'PostConfirmationLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    // ------------------------------------------------------------------ //
    // Lambda – Post-confirmation trigger (auto-assign to "user" group)
    // ------------------------------------------------------------------ //
    const postConfirmationFn = new lambdaNodejs.NodejsFunction(
      this,
      'PostConfirmationFn',
      {
        functionName: 'ai-todo-post-confirmation',
        runtime: lambda.Runtime.NODEJS_20_X,
        role: postConfirmationRole,
        timeout: cdk.Duration.seconds(10),
        memorySize: 128,
        entry: path.join(__dirname, '../lambda/auth/postConfirmation.ts'),
        environment: {
          REGION: this.region,
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: {
          minify: true,
          sourceMap: true,
          externalModules: ['@aws-sdk/*'],
          target: 'es2020',
        },
      },
    );

    // ------------------------------------------------------------------ //
    // Lambda – Pre-signup trigger (domain restriction)
    // ------------------------------------------------------------------ //
    const preSignUpFn = new lambdaNodejs.NodejsFunction(this, 'PreSignUpFn', {
      functionName: 'ai-todo-pre-signup',
      runtime: lambda.Runtime.NODEJS_20_X,
      role: preSignUpRole,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      entry: path.join(__dirname, '../lambda/auth/preSignUp.ts'),
      environment: {
        ALLOWED_DOMAIN_SECRET_ARN: this.allowedDomainSecret.secretArn,
        REGION: this.region,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        target: 'es2020',
      },
    });

    // ------------------------------------------------------------------ //
    // Cognito User Pool
    // ------------------------------------------------------------------ //
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'ai-todo-user-pool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
      },
      customAttributes: {
        weeklyGoal: new cognito.NumberAttribute({ mutable: true }),
        exerciseIntensity: new cognito.StringAttribute({ mutable: true }),
        sleepTarget: new cognito.NumberAttribute({ mutable: true }),
        dietGoal: new cognito.StringAttribute({ mutable: true }),
        lifePattern: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // SES 送信元設定（迷惑メール対策）
      // SES_FROM_EMAIL 環境変数が設定されている場合のみ SES を使用
      // 前提: ap-northeast-1 の SES で fromEmail アドレスの認証が必要
      ...(process.env.SES_FROM_EMAIL
        ? {
            email: cognito.UserPoolEmail.withSES({
              sesRegion: 'ap-northeast-1',
              fromEmail: process.env.SES_FROM_EMAIL,
              fromName: 'Health Todo',
            }),
          }
        : {}),
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lambdaTriggers: {
        preSignUp: preSignUpFn,
        postConfirmation: postConfirmationFn,
      },
    });

    // postConfirmation Lambda に AdminAddUserToGroup 権限を付与
    // NOTE: this.userPool.userPoolArn を使うと UserPool ↔ Lambda Role の循環依存が発生するため
    //       ワイルドカード ARN でアカウント・リージョンを限定する
    postConfirmationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminAddUserToGroup'],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`,
        ],
      }),
    );

    // ------------------------------------------------------------------ //
    // Cognito Groups
    //   admin     (precedence=1)  : 管理者 – 全機能 + 管理者ダッシュボード
    //   analyst   (precedence=5)  : 分析者 – データ分析ダッシュボードへのアクセス
    //   user      (precedence=10) : 一般ユーザー – 標準機能のみ
    // ------------------------------------------------------------------ //
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: '管理者 – 全機能 + 管理者ダッシュボード',
      precedence: 1,
    });

    new cognito.CfnUserPoolGroup(this, 'AnalystGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'analyst',
      description: '分析者 – データ分析ダッシュボードへのアクセス',
      precedence: 5,
    });

    new cognito.CfnUserPoolGroup(this, 'UserGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'user',
      description: '一般ユーザー – 標準機能のみ',
      precedence: 10,
    });

    // User Pool Domain (for Hosted UI)
    this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `ai-todo-${this.account}`,
      },
    });

    // User Pool Client
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'ai-todo-web-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        // Update callbackUrls after deploying CloudFront
        callbackUrls: ['http://localhost:3000/callback'],
        logoutUrls: ['http://localhost:3000'],
      },
      preventUserExistenceErrors: true,
    });

    // ------------------------------------------------------------------ //
    // IAM – Lambda Execution Role (shared by all Lambda functions)
    // ------------------------------------------------------------------ //
    this.lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: 'ai-todo-lambda-execution-role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
      inlinePolicies: {
        DynamoDB: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:BatchWriteItem',
                'dynamodb:BatchGetItem',
              ],
              resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/ai-todo-*`,
                `arn:aws:dynamodb:${this.region}:${this.account}:table/ai-todo-*/index/*`,
              ],
            }),
          ],
        }),
        SecretsManager: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: [
                this.geminiApiKeySecret.secretArn,
                this.allowedDomainSecret.secretArn,
              ],
            }),
          ],
        }),
      },
    });

    // ------------------------------------------------------------------ //
    // Outputs
    // ------------------------------------------------------------------ //
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: 'AiTodoUserPoolId',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'AiTodoUserPoolClientId',
    });
    new cdk.CfnOutput(this, 'GeminiSecretArn', {
      value: this.geminiApiKeySecret.secretArn,
      exportName: 'AiTodoGeminiSecretArn',
    });
    new cdk.CfnOutput(this, 'AllowedDomainSecretArn', {
      value: this.allowedDomainSecret.secretArn,
      exportName: 'AiTodoAllowedDomainSecretArn',
    });
  }
}
