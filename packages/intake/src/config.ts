import { z } from 'zod';
import { boardSchema, repoPathOverridesSchema, xorDbBoard } from '@agentfactory/core';

export const intakeConfigBaseSchema = z.object({
  db: z.string().min(1).optional(), board: boardSchema.optional(), repoPathOverrides: repoPathOverridesSchema.optional(),
  name: z.string().min(1).default('intake'), pollSeconds: z.number().positive().default(30),
  settleSeconds: z.number().nonnegative().default(60), maxPerTick: z.number().int().positive().default(5),
  provider: z.object({
    name: z.enum(['fixture', 'jev']), endpoint: z.string().url().optional(), apiKeyEnv: z.string().min(1).default('TYPESAFE_API_KEY'),
    model: z.string().min(1).default('jev-1.13.0'), timeoutSeconds: z.number().int().min(1).max(120).default(20),
    fixtures: z.record(z.unknown()).optional(), sendWorkspacePolicy: z.boolean().default(false),
  }).strict().optional(),
}).strict();
export const intakeConfigSchema = intakeConfigBaseSchema.superRefine(xorDbBoard);
export type IntakeConfig = z.infer<typeof intakeConfigBaseSchema>;
export function parseConfig(raw: unknown): IntakeConfig { return intakeConfigSchema.parse(raw); }
export function loadConfig(path: string, readFile: (p: string) => string): IntakeConfig { return parseConfig(JSON.parse(readFile(path))); }
