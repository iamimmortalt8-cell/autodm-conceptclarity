import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { appUrl } from "@/env";
import { deriveKey, randomToken, safeEqual } from "@/server/crypto";
import type { InstagramAccount } from "@/server/db/schema";
import type { SubscriptionStatus } from "@/lib/webhook-diagnostics";
import { logger } from "@/server/log";
import { getSettings, setSetting } from "@/server/settings";
import { getAccessToken, tokenResponseSchema, upsertAccount } from "./account";
import {
  graphAuthForSetup,
  IG_AUTHORIZE_URL,
  IG_LONG_TOKEN_URL,
  IG_SCOPES,
  IG_SHORT_TOKEN_URL,
  UNIFIED_LOGIN_URL,
  UNIFIED_TOKEN_URL,
} from "./constants";
import { GraphApiError, graphId, graphRequest, safeErrorMessage } from "./graph";

const log = logger("oauth");

export const OAUTH_STATE_COOKIE = "ig_oauth_state";
export const OAUTH_STATE_MAX_AGE_S = 10 * 60;
export const OAUTH_CALLBACK_PATH = "/api/instagram/oauth/callback";

/** Machine-readable failure reasons surfaced to the settings page as `?error=<code>`. */
export type OAuthErrorCode =
  | "missing_app_credentials"
  | "access_denied"
  | "invalid_state"
  | "missing_code"
  | "missing_permissions"
  | "token_exchange_failed"
  | "profile_fetch_failed"
  | "instagram_account_missing"
  | "multiple_instagram_accounts";

export class OAuthFlowError extends Error {
  override readonly name = "OAuthFlowError";
  constructor(
    readonly code: OAuthErrorCode,
    readonly cause?: unknown,
  ) {
    super(code);
  }
}

/** The redirect URI registered in the Meta app dashboard. */
export function oauthRedirectUri(): string {
  return `${appUrl()}${OAUTH_CALLBACK_PATH}`;
}

/* ---------------------------------- state ---------------------------------- */

function signState(state: string): string {
  return createHmac("sha256", deriveKey("session")).update(`ig-oauth:${state}`).digest("base64url");
}

/** New CSRF state: `state` goes to Instagram, `cookieValue` into an httpOnly cookie. */
export function createOAuthState(): { state: string; cookieValue: string } {
  const state = randomToken(32);
  return { state, cookieValue: `${state}.${signState(state)}` };
}

/** Timing-safe check that the returned `state` matches the signed cookie. */
export function verifyOAuthState(returnedState: string | null, cookieValue: string | undefined): boolean {
  if (!returnedState || !cookieValue) return false;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return false;
  const state = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  return safeEqual(sig, signState(state)) && safeEqual(state, returnedState);
}

/* ---------------------------------- flow ----------------------------------- */

async function getAppCredentials(): Promise<{ appId: string; appSecret: string; configId?: string }> {
  const s = await getSettings(["meta.appId", "meta.appSecret", "meta.configId"]);
  const appId = s["meta.appId"];
  const appSecret = s["meta.appSecret"];
  if (!appId || !appSecret) throw new OAuthFlowError("missing_app_credentials");
  return { appId, appSecret, configId: s["meta.configId"] };
}

/** Builds the configured Meta login URL. A config ID selects Unified Login. */
export async function buildAuthorizeUrl(state: string): Promise<string> {
  const { appId, configId } = await getAppCredentials();
  const redirectUri = oauthRedirectUri();
  const url = new URL(configId ? UNIFIED_LOGIN_URL : IG_AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (configId) {
    url.searchParams.set("config_id", configId);
    url.searchParams.set("display", "popup");
    url.searchParams.set("prompt", "login");
  } else {
    url.searchParams.set("scope", IG_SCOPES.join(","));
    url.searchParams.set("enable_fb_login", "0");
    url.searchParams.set("force_reauth", "true");
  }
  log.info("oauth.authorize_url_built", {
    loginType: configId ? "unified_login" : "instagram_login",
    appId,
    configId: configId ?? null,
    redirectUri,
  });
  return url.toString();
}

const permissionsSchema = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((p) => (typeof p === "string" ? p.split(",").map((s) => s.trim()) : p));

/** Docs show both a flat object and a `{ data: [...] }` wrapper; accept either. */
const shortTokenItem = z.object({ access_token: z.string().min(1), permissions: permissionsSchema });
const shortTokenSchema = z.union([
  shortTokenItem,
  z.object({ data: z.array(shortTokenItem).min(1) }).transform((d) => d.data[0]!),
]);

const profileSchema = z.object({
  user_id: graphId,
  username: z.string().min(1),
  name: z.string().optional(),
  profile_picture_url: z.string().optional(),
});

const subscribeSchema = z.object({ success: z.boolean().optional() });

export interface ConnectResult {
  account: InstagramAccount;
  /** False when the account was saved but the webhook subscription failed (retryable). */
  subscribed: boolean;
}

/**
 * Completes the OAuth flow: code -> short-lived -> long-lived token, fetch profile, store the
 * encrypted token, subscribe the app to `comments` webhooks. Throws {@link OAuthFlowError}.
 */
const unifiedBusinessSchema = z.object({ client_business_id: graphId });
const assignedInstagramAccountsSchema = z.object({
  data: z.array(z.object({ id: graphId, username: z.string().min(1) })),
});

/** Exchanges a Unified Login code and resolves exactly one authorized Instagram account. */
async function completeUnifiedOAuth(
  rawCode: string,
  credentials: { appId: string; appSecret: string; configId?: string },
): Promise<ConnectResult> {
  const code = rawCode.replace(/#_.*$/, "").replace(/#.*$/, "");
  const redirectUri = oauthRedirectUri();
  log.info("oauth.unified_token_exchange_start", {
    appId: credentials.appId,
    configId: credentials.configId ?? null,
    redirectUri,
    codeLength: code.length,
  });
  let token: z.infer<typeof tokenResponseSchema>;
  let clientBusinessId: string;
  let accounts: z.infer<typeof assignedInstagramAccountsSchema>["data"];
  const auth = graphAuthForSetup("unified_login");
  try {
    token = await graphRequest({
      path: UNIFIED_TOKEN_URL,
      query: {
        client_id: credentials.appId,
        client_secret: credentials.appSecret,
        redirect_uri: redirectUri,
        code,
      },
      schema: tokenResponseSchema,
      retries: 0,
    });
    log.info("oauth.unified_token_exchange_received", {
      hasToken: !!token.access_token,
      expiresIn: token.expires_in ?? null,
      tokenType: token.token_type ?? null,
    });
    const business = await graphRequest({
      path: "/me",
      query: { fields: "client_business_id" },
      accessToken: token.access_token,
      ...auth,
      schema: unifiedBusinessSchema,
    });
    clientBusinessId = business.client_business_id;
    const assigned = await graphRequest({
      path: "/me/assigned_instagram_accounts",
      query: { fields: "id,username" },
      accessToken: token.access_token,
      ...auth,
      schema: assignedInstagramAccountsSchema,
    });
    accounts = assigned.data;
    log.info("oauth.unified_accounts_resolved", {
      clientBusinessId,
      accountCount: accounts.length,
      usernames: accounts.map((a) => a.username),
    });
  } catch (err) {
    log.warn("oauth.unified_token_exchange_failed", {
      err: safeErrorMessage(err),
      redirectUri,
    });
    throw new OAuthFlowError("token_exchange_failed", err);
  }
  if (accounts.length !== 1) {
    throw new OAuthFlowError(accounts.length ? "multiple_instagram_accounts" : "instagram_account_missing");
  }
  const selected = accounts[0]!;
  const account = await upsertAccount({
    igUserId: selected.id,
    username: selected.username,
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in ?? null,
    apiSetup: "unified_login",
    clientBusinessId,
    loginConfigId: credentials.configId ?? null,
  });
  const status = await subscribeAndRecord(account, "connect");
  return { account, subscribed: status.ok };
}

export async function completeOAuth(rawCode: string): Promise<ConnectResult> {
  const credentials = await getAppCredentials();
  if (credentials.configId) return completeUnifiedOAuth(rawCode, credentials);
  const { appId, appSecret } = credentials;
  // Instagram appends `#_` to the code in the redirect; strip it if it leaked into the value.
  const code = rawCode.replace(/#_.*$/, "").replace(/#.*$/, "");

  let longToken: z.infer<typeof tokenResponseSchema>;
  try {
    const short = await graphRequest({
      method: "POST",
      path: IG_SHORT_TOKEN_URL,
      form: {
        client_id: appId,
        client_secret: appSecret,
        grant_type: "authorization_code",
        redirect_uri: oauthRedirectUri(),
        code,
      },
      schema: shortTokenSchema,
      retries: 0,
    });
    if (short.permissions && !IG_SCOPES.every((s) => short.permissions!.includes(s))) {
      throw new OAuthFlowError("missing_permissions");
    }
    longToken = await graphRequest({
      path: IG_LONG_TOKEN_URL,
      query: { grant_type: "ig_exchange_token", client_secret: appSecret },
      accessToken: short.access_token,
      schema: tokenResponseSchema,
    });
  } catch (err) {
    if (err instanceof OAuthFlowError) throw err;
    throw new OAuthFlowError("token_exchange_failed", err);
  }

  let profile: z.infer<typeof profileSchema>;
  try {
    profile = await graphRequest({
      path: "/me",
      query: { fields: "user_id,username,name,profile_picture_url" },
      accessToken: longToken.access_token,
      schema: profileSchema,
    });
  } catch (err) {
    throw new OAuthFlowError("profile_fetch_failed", err);
  }

  const account = await upsertAccount({
    igUserId: profile.user_id,
    username: profile.username,
    name: profile.name ?? null,
    profilePictureUrl: profile.profile_picture_url ?? null,
    accessToken: longToken.access_token,
    expiresInSeconds: longToken.expires_in ?? null,
  });

  const status = await subscribeAndRecord(account, "connect");
  return { account, subscribed: status.ok };
}

/** Subscribes the app to the account's `comments` and `messaging_postbacks` webhook fields. Returns false on failure. */
export async function subscribeToWebhooks(accessToken: string): Promise<boolean> {
  return (await subscribeWithDetails(accessToken)).ok;
}

/** Webhook fields we subscribe to: comments (engine) and postbacks (follow gate button). */
export const WEBHOOK_SUBSCRIBED_FIELDS = "comments,messaging_postbacks";

const subscribedAppsSchema = z.object({
  data: z.array(z.looseObject({ subscribed_fields: z.array(z.string()).optional() })).optional(),
});

/**
 * `POST /me/subscribed_apps?subscribed_fields=comments,messaging_postbacks`, then (best-effort) reads back the
 * subscribed fields. Never throws for Graph API errors; the error text is token-free.
 */
export async function subscribeWithDetails(
  accessToken: string,
  account?: Pick<InstagramAccount, "igUserId" | "apiSetup">,
): Promise<{ ok: boolean; fields?: string[]; error?: string }> {
  const auth = graphAuthForSetup(account?.apiSetup);
  const path = account?.apiSetup === "unified_login"
    ? "/" + encodeURIComponent(account.igUserId) + "/subscribed_apps"
    : "/me/subscribed_apps";
  try {
    const res = await graphRequest({
      method: "POST",
      path,
      query: { subscribed_fields: WEBHOOK_SUBSCRIBED_FIELDS },
      accessToken,
      ...auth,
      schema: subscribeSchema,
      idempotent: true,
    });
    if (res.success === false) return { ok: false, error: "Instagram answered success: false" };
  } catch (err) {
    if (err instanceof GraphApiError) return { ok: false, error: safeErrorMessage(err, [accessToken], 300) };
    throw err;
  }
  try {
    const current = await graphRequest({
      path,
      accessToken,
      ...auth,
      schema: subscribedAppsSchema,
      retries: 0,
      timeoutMs: 5_000,
    });
    const fields = [...new Set((current.data ?? []).flatMap((d) => d.subscribed_fields ?? []))].slice(0, 20);
    return { ok: true, fields };
  } catch {
    return { ok: true };
  }
}

/** Subscribes and persists the outcome in the `webhook.subscription` setting (best-effort). */
export async function subscribeAndRecord(
  account: InstagramAccount,
  source: SubscriptionStatus["source"],
): Promise<SubscriptionStatus> {
  const result = await subscribeWithDetails(getAccessToken(account), account);
  const status: SubscriptionStatus = {
    ok: result.ok,
    at: new Date().toISOString(),
    source,
    ...(result.fields ? { fields: result.fields } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  try {
    await setSetting("webhook.subscription", status);
  } catch (err) {
    log.warn("webhook.subscription_record_failed", { err: safeErrorMessage(err) });
  }
  log.info("webhook.subscribed", { ok: status.ok, source, fields: status.fields });
  return status;
}
