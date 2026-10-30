import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
});

export interface Config {
  port: number;
  jwtSecret: string;
  allowedOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return {
    port: parsed.PORT,
    jwtSecret: parsed.JWT_SECRET,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
  };
}
