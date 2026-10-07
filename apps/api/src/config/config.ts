import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTROL_DATABASE_URL: z
    .string()
    .url()
    .default('postgres://bench:bench@127.0.0.1:5432/aerolith_control'),
  SESSION_SIGNING_KEY: z.string().min(32).optional(),
  LICENCE_KEY_PEPPER: z.string().min(32).optional(),
  CONTROL_PLANE_ENC_KEY: z.string().optional(),
  ENTITLEMENT_PRIVATE_KEY_PEM: z.string().optional(),
  TRIAL_DAYS: z.coerce.number().int().positive().default(120),
  TRIAL_GRACE_DAYS: z.coerce.number().int().min(0).default(7),
  MIN_SHORTEN_NOTICE_DAYS: z.coerce.number().int().min(0).default(14),
  ENTITLEMENT_TTL_HOURS: z.coerce.number().int().positive().default(168),
  DEVICES_PER_SEAT: z.coerce.number().int().positive().default(2),
  PUBLIC_API_URL: z.string().url().default('http://127.0.0.1:3000'),
  WEBSITE_URL: z.string().url().default('http://localhost:5173'),
  LOCAL_PG_ADMIN_URL: z.string().url().optional(),
  SUPABASE_API_URL: z.string().url().default('https://api.supabase.com'),
  SUPABASE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  SUPABASE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  TENANT_DB_REGION: z.string().default('ap-south-1'),
  PROVISIONING_WORKER: z.enum(['on', 'off']).optional(),
  MAX_TENANT_POOLS: z.coerce.number().int().positive().default(50),
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  controlDatabaseUrl: string;
  /** Signs access tokens and keys refresh-token HMACs. */
  sessionKey: Buffer;
  licenceKeyPepper: Buffer;
  controlPlaneEncKey: Buffer;
  entitlementPrivateKey: KeyObject;
  trialDays: number;
  trialGraceDays: number;
  minShortenNoticeDays: number;
  entitlementTtlHours: number;
  devicesPerSeat: number;
  publicApiUrl: string;
  websiteUrl: string;
  /** Superuser URL of a Postgres server for the local stand-in provider. Unset = provider disabled. */
  localPgAdminUrl: string | null;
  supabase: { apiUrl: string; clientId: string; clientSecret: string; redirectUri: string } | null;
  tenantDbRegion: string;
  provisioningWorker: boolean;
  maxTenantPools: number;
  /** Multiplies every rate limit (tests raise it). */
  rateLimitScale: number;
  /** Trust X-Forwarded-For (only behind a proxy/tunnel that sets it). */
  trustProxy: boolean;
  /** Secrets generated for this process only (development/test). Never true in production. */
  ephemeralSecrets: string[];
}

/**
 * Production refuses to start without every secret. Development and test generate throwaway secrets so the
 * app runs out of the box; anything signed or encrypted with them is useless after a restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  const ephemeral: string[] = [];
  const required = <T>(name: string, value: T | undefined, make: () => T): T => {
    if (value !== undefined) return value;
    if (e.NODE_ENV === 'production') throw new Error(`${name} must be set in production`);
    ephemeral.push(name);
    return make();
  };

  const encKey = Buffer.from(
    required('CONTROL_PLANE_ENC_KEY', e.CONTROL_PLANE_ENC_KEY, () =>
      randomBytes(32).toString('base64'),
    ),
    'base64',
  );
  if (encKey.length !== 32)
    throw new Error('CONTROL_PLANE_ENC_KEY must be 32 bytes, base64-encoded');

  const pem = required('ENTITLEMENT_PRIVATE_KEY_PEM', e.ENTITLEMENT_PRIVATE_KEY_PEM, () =>
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  const entitlementPrivateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (entitlementPrivateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('ENTITLEMENT_PRIVATE_KEY_PEM must be an Ed25519 key');

  return {
    env: e.NODE_ENV,
    controlDatabaseUrl: e.CONTROL_DATABASE_URL,
    sessionKey: Buffer.from(
      required('SESSION_SIGNING_KEY', e.SESSION_SIGNING_KEY, () =>
        randomBytes(32).toString('base64url'),
      ),
    ),
    licenceKeyPepper: Buffer.from(
      required('LICENCE_KEY_PEPPER', e.LICENCE_KEY_PEPPER, () =>
        randomBytes(32).toString('base64url'),
      ),
    ),
    controlPlaneEncKey: encKey,
    entitlementPrivateKey,
    trialDays: e.TRIAL_DAYS,
    trialGraceDays: e.TRIAL_GRACE_DAYS,
    minShortenNoticeDays: e.MIN_SHORTEN_NOTICE_DAYS,
    entitlementTtlHours: e.ENTITLEMENT_TTL_HOURS,
    devicesPerSeat: e.DEVICES_PER_SEAT,
    publicApiUrl: e.PUBLIC_API_URL,
    websiteUrl: e.WEBSITE_URL,
    localPgAdminUrl: e.LOCAL_PG_ADMIN_URL ?? null,
    supabase:
      e.SUPABASE_OAUTH_CLIENT_ID && e.SUPABASE_OAUTH_CLIENT_SECRET
        ? {
            apiUrl: e.SUPABASE_API_URL,
            clientId: e.SUPABASE_OAUTH_CLIENT_ID,
            clientSecret: e.SUPABASE_OAUTH_CLIENT_SECRET,
            redirectUri: new URL('/api/onboarding/supabase/callback', e.PUBLIC_API_URL).toString(),
          }
        : null,
    tenantDbRegion: e.TENANT_DB_REGION,
    provisioningWorker: (e.PROVISIONING_WORKER ?? (e.NODE_ENV === 'test' ? 'off' : 'on')) === 'on',
    maxTenantPools: e.MAX_TENANT_POOLS,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    trustProxy: e.TRUST_PROXY === 'true',
    ephemeralSecrets: ephemeral,
  };
}
