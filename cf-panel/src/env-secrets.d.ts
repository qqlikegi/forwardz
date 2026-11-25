// Optional Wrangler Secrets (configured via `wrangler secret put` or `.dev.vars`)
interface Env {
  JWT_SECRET?: string;
  MIGRATION_TOKEN?: string;
}
