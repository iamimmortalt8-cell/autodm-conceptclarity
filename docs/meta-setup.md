# Meta Unified Login setup

This guide configures a self-hosted AutoDM instance with Meta's current Instagram API with Unified Login. Use a Meta app that has the Instagram API with Unified Login use case and a Facebook Login for Business configuration. Instagram Login uses a different OAuth flow and is not compatible with this setup.

## Required values

Set these deployment environment variables in your host:

- DATABASE_URL (or the supported Supabase/Vercel database URL)
- APP_SECRET (at least 32 characters; encrypts stored credentials and signs sessions)
- APP_URL (the public HTTPS origin of this AutoDM instance, with no trailing slash)
- CRON_SECRET (if using the scheduled token maintenance route)

There is no Meta credential environment variable. In Settings → Instagram, save the Meta App ID, App Secret, and Facebook Login for Business Configuration ID. AutoDM encrypts the App Secret in its database. The configuration ID is not secret. Never place tokens or App Secrets in source control, client-side settings, URLs you share, or logs.

Exact URLs:

- OAuth redirect/callback: {APP_URL}/api/instagram/oauth/callback
- Instagram webhook callback: {APP_URL}/api/webhooks/instagram
- Deauthorization callback: {APP_URL}/api/instagram/deauthorize
- Data deletion callback: {APP_URL}/api/instagram/data-deletion

Use the callback and webhook URLs exactly as shown in Settings → Instagram. HTTPS is required for a public deployment.

## Meta dashboard

1. Create/use a Business Meta app with the Instagram API with Unified Login use case. Add the Facebook Login for Business product and create a configuration for this use case.
2. In the configuration, choose Instagram account access as required. For this single-account AutoDM instance, authorize exactly one professional Instagram account. If the configuration permits optional ad accounts, they are not needed for AutoDM.
3. Request at least instagram_basic, instagram_manage_comments, and instagram_manage_messages. These support account discovery, comment webhooks/moderation, private replies, and messaging. Add other permissions only when your app feature needs them.
4. Set the configuration's Valid OAuth Redirect URI to {APP_URL}/api/instagram/oauth/callback. Save the configuration and copy its Configuration ID.
5. In App settings → Basic, copy the Meta App ID and App Secret. Save those plus the Configuration ID in AutoDM Settings → Instagram.
6. Configure Instagram webhooks using {APP_URL}/api/webhooks/instagram and the verify token displayed in AutoDM Settings → Instagram. Verify/save the callback and subscribe to comments and messaging_postbacks. The latter is used by the optional follow-gate postback button. AutoDM verifies X-Hub-Signature-256 against the Meta App Secret.
7. Configure the app's deauthorization and data deletion callback URLs above if you use those Meta app capabilities. AutoDM validates the signed request and removes or deletes the associated stored data.
8. Grant the app's required access level for the Instagram accounts you will serve. Meta's current Unified Login setup does not support test users; use app roles and supported access levels for development and complete App Review/Advanced Access where Meta requires it for external accounts or webhook permissions.
9. In AutoDM click Connect Instagram, sign in, approve access, and select one professional account. The OAuth completion exchanges the code, reads /me?fields=client_business_id and /me/assigned_instagram_accounts?fields=id,username, saves the selected account and token encrypted, then subscribes that account to the webhook fields. If zero or multiple accounts are returned, AutoDM reports the mismatch instead of silently choosing an account.
10. Test with a comment from a different Instagram account, then confirm the comment arrives in Activity and the configured public reply/private reply is sent.

## OAuth and token behavior

AutoDM redirects to Meta's OAuth dialog with the Meta App ID, exact redirect URI, response_type=code, the saved config_id, state, and Meta's documented display=popup and prompt=login parameters. The callback verifies the signed, short-lived state cookie before exchanging the code at the versioned Graph API oauth/access_token endpoint using the Meta App ID and App Secret.

The returned Business Integration System User (BISU) token is used against graph.facebook.com with the authorized Instagram professional account ID. The token is encrypted at rest and sent to Meta in an Authorization Bearer header. /me in this flow is the BISU identity; AutoDM separately resolves and stores the Instagram account ID and client business ID. Existing campaigns remain attached to the same account row on reconnect.

Configure the login to produce a token with Never expiration, as in the supplied Meta configuration. AutoDM does not apply Instagram Login's ig_refresh_token endpoint to a Unified Login token. If Meta returns an expiring Unified Login token, AutoDM records its expiry and refuses to guess a refresh route once renewal is due; reconnect using a never-expiring configuration. Revocation, removal of business asset access, or changing the login configuration can still invalidate access and require reconnecting.

Instagram Login accounts already in the database retain their existing API mode and refresh path. A new Unified Login connection is saved as Unified Login; existing data and migrations are preserved.

## Troubleshooting

- missing_app_credentials: save the Meta App ID and App Secret.
- OAuth redirect mismatch: compare the exact HTTPS URL in AutoDM with the Valid OAuth Redirect URI in the Login for Business configuration.
- No Instagram account returned: ensure the signed-in business has assigned an Instagram Professional account and the configuration requested that asset.
- More than one account returned: set the Login for Business configuration to authorize one account, then reconnect.
- Webhook subscription failed: verify the comments and messaging_postbacks fields, permissions, callback verification, and account connection. Retry from Webhook diagnostics.
- Invalid signature: ensure the Meta App Secret saved in AutoDM belongs to the Meta App ID used by the callback.
- Expired/revoked token: reconnect the Instagram account in AutoDM and check the business asset assignment.

## Official Meta documentation

- [Get started with Instagram API with Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started)
- [Authentication](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication)
- [Migration from Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/migration)
- [Permissions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/permissions)
- [Webhooks setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)
- [Webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields)
- [Private Replies](https://developers.facebook.com/documentation/instagram-platform/private-replies)
- [Comment moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation)
- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
