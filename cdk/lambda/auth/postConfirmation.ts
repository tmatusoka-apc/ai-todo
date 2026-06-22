import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type {
  PostConfirmationTriggerEvent,
  PostConfirmationTriggerHandler,
} from 'aws-lambda';

const cip = new CognitoIdentityProviderClient({
  region: process.env.REGION ?? 'ap-northeast-1',
});

export const handler: PostConfirmationTriggerHandler = async (
  event: PostConfirmationTriggerEvent,
) => {
  // メール確認完了後のサインアップのみ対象（管理者作成ユーザーは除く）
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    await cip.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        GroupName: 'user', // デフォルトは一般ユーザー
      }),
    );
  }
  return event;
};
