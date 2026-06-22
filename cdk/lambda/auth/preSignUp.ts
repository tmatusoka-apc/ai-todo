import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type {
  PreSignUpTriggerEvent,
  PreSignUpTriggerHandler,
} from 'aws-lambda';

const sm = new SecretsManagerClient({ region: process.env.REGION ?? 'ap-northeast-1' });

let cachedDomain: string | null = null;
let cacheExpiry = 0;

async function getAllowedDomain(): Promise<string> {
  if (cachedDomain && Date.now() < cacheExpiry) return cachedDomain;

  const secretArn = process.env.ALLOWED_DOMAIN_SECRET_ARN!;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = res.SecretString ?? '{}';
  const parsed = JSON.parse(value) as { domain?: string };
  cachedDomain = parsed.domain ?? 'anyone';
  cacheExpiry = Date.now() + 5 * 60 * 1000; // cache 5 minutes
  return cachedDomain;
}

export const handler: PreSignUpTriggerHandler = async (
  event: PreSignUpTriggerEvent,
) => {
  const email: string = event.request.userAttributes.email ?? '';
  const allowedDomain = await getAllowedDomain();

  if (allowedDomain !== 'anyone') {
    const emailDomain = email.split('@')[1] ?? '';
    if (emailDomain.toLowerCase() !== allowedDomain.toLowerCase()) {
      throw new Error(
        `このサービスは @${allowedDomain} のメールアドレス専用です`,
      );
    }
  }

  // Auto-confirm + auto-verify for corporate sign-ups (optional: remove for production)
  // event.response.autoConfirmUser = true;
  // event.response.autoVerifyEmail = true;

  return event;
};
