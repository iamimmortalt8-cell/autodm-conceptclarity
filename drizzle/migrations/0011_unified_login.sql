ALTER TABLE "instagram_accounts" ADD COLUMN "api_setup" text NOT NULL DEFAULT 'instagram_login';
ALTER TABLE "instagram_accounts" ADD COLUMN "client_business_id" text;
ALTER TABLE "instagram_accounts" ADD COLUMN "login_config_id" text;
