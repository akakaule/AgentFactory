import type { DB } from '../db.js';
import type { IntakeSettings } from '../types.js';
import { transaction } from '../transaction.js';
import { getKv, setKv } from '../repo/kv.js';
import { defaultIntakeSettings, INTAKE_SETTINGS_KEY, normalizeIntakeSettings, parseIntakeSettingsUpdate } from '../intakeSettings.js';

export function getIntakeSettings(db: DB): IntakeSettings {
  const raw = getKv(db, INTAKE_SETTINGS_KEY);
  if (!raw) return { ...defaultIntakeSettings, workspaces: [] };
  try { return normalizeIntakeSettings(JSON.parse(raw) as unknown); } catch { return { ...defaultIntakeSettings, workspaces: [] }; }
}

export function setIntakeSettings(db: DB, input: unknown): IntakeSettings {
  const settings = parseIntakeSettingsUpdate(input);
  return transaction(db, () => {
    setKv(db, INTAKE_SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  });
}
