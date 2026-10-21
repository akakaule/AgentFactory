import { z } from 'zod';
import { ValidationError } from './errors.js';
import type { IntakeSettings } from './types.js';

export const INTAKE_SETTINGS_KEY = 'intake_settings';
export const defaultIntakeSettings: IntakeSettings = {
  mode: 'off', workspaces: [], sendWorkspacePolicy: false, settleSeconds: 60, maxPerTick: 5,
  maxAttempts: 3, readinessNeedsAttention: true, readinessThreshold: 0.6,
  architecturalNeedsAttention: true, riskAttentionLevel: null, maxHoldMinutes: 10,
};

const settingsSchema = z.object({
  mode: z.enum(['off', 'advisory', 'enforced']), workspaces: z.array(z.string().trim().min(1)), sendWorkspacePolicy: z.boolean(),
  settleSeconds: z.number().int().min(0).max(86_400), maxPerTick: z.number().int().min(1).max(1_000),
  maxAttempts: z.number().int().min(1).max(10), readinessNeedsAttention: z.boolean(), readinessThreshold: z.number().finite().min(0).max(1),
  architecturalNeedsAttention: z.boolean(), riskAttentionLevel: z.enum(['low', 'medium', 'high', 'critical']).nullable(), maxHoldMinutes: z.number().int().min(1).max(1_440),
}).strict();

function clean(input: Partial<IntakeSettings>): IntakeSettings {
  return {
    ...defaultIntakeSettings,
    ...input,
    workspaces: [...new Set((input.workspaces ?? defaultIntakeSettings.workspaces).map((w) => w.trim()).filter(Boolean))],
  };
}

/** Stored settings are untrusted: a missing or corrupt row is always safely off. */
export function normalizeIntakeSettings(raw: unknown): IntakeSettings {
  if (raw === null || typeof raw !== 'object') return { ...defaultIntakeSettings, workspaces: [] };
  const result = settingsSchema.safeParse(raw);
  if (!result.success || result.data.mode === 'enforced') return { ...defaultIntakeSettings, workspaces: [] };
  return clean(result.data);
}

/** Explicit human writes are strict and can never enable the deferred enforced mode. */
export function parseIntakeSettingsUpdate(raw: unknown): IntakeSettings {
  if (raw === null || typeof raw !== 'object') throw new ValidationError('intake settings must be an object');
  const result = settingsSchema.safeParse({ ...defaultIntakeSettings, ...(raw as object) });
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join('; '));
  if (result.data.mode === 'enforced') throw new ValidationError('intake enforced mode is not available');
  return clean(result.data);
}

export function intakeEnabledFor(settings: IntakeSettings, workspace: string): boolean {
  return settings.mode !== 'off' && settings.workspaces.includes(workspace);
}
