export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
}

/** Reads and validates configuration from environment variables. Throws on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${env.PORT}"`);
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
