/**
 * Client-side mirror of the board-editable supervisor settings (the client can't import core's
 * node:sqlite runtime). Each field maps to a dotted path in the sparse settings object core stores;
 * a blank value means "inherit the JSON-file default". Core validates authoritatively on PUT.
 */
export const SUPERVISOR_KINDS = ['dispatcher', 'reviewer', 'watcher'] as const;
export type SupervisorKind = (typeof SUPERVISOR_KINDS)[number];

export type FieldType = 'number' | 'boolean' | 'select' | 'text' | 'list';

export interface SettingField {
  key: string; // dotted path into the settings object, e.g. 'otel.endpoint', 'stageEngines.implementation'
  label: string;
  type: FieldType;
  options?: string[]; // for 'select' (a leading '' option = inherit)
  hint?: string;
  placeholder?: string; // usually the file default, e.g. 'default 15'
}

const ENGINE = ['', 'claude', 'codex'];

export const SUPERVISOR_META: { kind: SupervisorKind; title: string; fields: SettingField[] }[] = [
  {
    kind: 'dispatcher',
    title: 'Dispatcher',
    fields: [
      { key: 'workspaces', label: 'Workspaces (allowlist)', type: 'list', hint: 'Comma-separated. Blank = serve every workspace.' },
      { key: 'excludeWorkspaces', label: 'Exclude workspaces', type: 'list', hint: 'Comma-separated opt-out list.' },
      { key: 'maxConcurrent', label: 'Max concurrent', type: 'number', placeholder: 'default 1' },
      { key: 'pollSeconds', label: 'Poll seconds', type: 'number', placeholder: 'default 15' },
      { key: 'permissionMode', label: 'Permission mode', type: 'select', options: ['', 'acceptEdits', 'bypassPermissions', 'default', 'plan'] },
      { key: 'engine', label: 'Engine (default)', type: 'select', options: ENGINE, hint: 'Worker engine for all stages unless a stage overrides below.' },
      { key: 'stageEngines.description', label: 'Engine · description', type: 'select', options: ENGINE },
      { key: 'stageEngines.plan', label: 'Engine · plan', type: 'select', options: ENGINE },
      { key: 'stageEngines.implementation', label: 'Engine · implementation', type: 'select', options: ENGINE },
      { key: 'claudeArgs', label: 'Claude args', type: 'list', hint: 'Comma-separated flags added to every claude invocation.' },
      { key: 'codexArgs', label: 'Codex args', type: 'list', hint: 'Comma-separated flags for a codex worker (sandbox/model).' },
      { key: 'maxSessionMinutes', label: 'Max session minutes', type: 'number', placeholder: 'default 60' },
      { key: 'maxAttempts', label: 'Max attempts', type: 'number', placeholder: 'default 2' },
      { key: 'staleClaimMinutes', label: 'Stale-claim minutes', type: 'number', placeholder: 'default 120 (0 disables)' },
      { key: 'otel.endpoint', label: 'OTel endpoint', type: 'text', hint: 'OTLP logs endpoint; the token stays in the config file.' },
    ],
  },
  {
    kind: 'reviewer',
    title: 'Reviewer',
    fields: [
      { key: 'workspaces', label: 'Workspaces (allowlist)', type: 'list', hint: 'Comma-separated. Blank = watch every workspace.' },
      { key: 'excludeWorkspaces', label: 'Exclude workspaces', type: 'list' },
      { key: 'engine', label: 'Engine', type: 'select', options: ENGINE, placeholder: 'default codex' },
      { key: 'model', label: 'Model', type: 'text' },
      { key: 'pollSeconds', label: 'Poll seconds', type: 'number', placeholder: 'default 60' },
      { key: 'maxConcurrent', label: 'Max concurrent', type: 'number', placeholder: 'default 1' },
      { key: 'reviewMinutes', label: 'Review minutes', type: 'number', placeholder: 'default 10' },
      { key: 'maxDiffChars', label: 'Max diff chars', type: 'number', placeholder: 'default 120000 (0 = no limit)' },
      { key: 'maxAttempts', label: 'Max attempts', type: 'number', placeholder: 'default 2' },
      { key: 'otel.endpoint', label: 'OTel endpoint', type: 'text' },
    ],
  },
  {
    kind: 'watcher',
    title: 'Watcher',
    fields: [
      { key: 'workspaces', label: 'Workspaces (allowlist)', type: 'list', hint: 'Comma-separated. Blank = serve every workspace.' },
      { key: 'excludeWorkspaces', label: 'Exclude workspaces', type: 'list' },
      { key: 'pollSeconds', label: 'Poll seconds', type: 'number', placeholder: 'default 60' },
      { key: 'postMergeChecks', label: 'Post-merge checks', type: 'boolean' },
      { key: 'maxBackoffSeconds', label: 'Max backoff seconds', type: 'number', placeholder: 'default 900' },
      { key: 'captureBuildErrors', label: 'Capture build errors', type: 'boolean', placeholder: 'default on' },
      { key: 'github.apiBase', label: 'GitHub API base', type: 'text', placeholder: 'https://api.github.com' },
      { key: 'azdo.apiVersion', label: 'Azure DevOps API version', type: 'text', placeholder: '7.1' },
    ],
  },
];

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string, val: unknown): void {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[parts[parts.length - 1]!] = val;
}

/** Flatten a stored (sparse) settings object to string form-values keyed by field path; '' = inherit. */
export function deserialize(fields: SettingField[], stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = getPath(stored, f.key);
    out[f.key] = v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** Build the sparse settings object to PUT: blank fields are omitted (inherit the file default). */
export function serialize(fields: SettingField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? '').trim();
    if (raw === '') continue;
    let val: unknown;
    if (f.type === 'number') {
      const n = Number(raw);
      if (Number.isNaN(n)) continue;
      val = n;
    } else if (f.type === 'boolean') {
      val = raw === 'true';
    } else if (f.type === 'list') {
      const arr = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (arr.length === 0) continue;
      val = arr;
    } else {
      val = raw; // text, select
    }
    setPath(out, f.key, val);
  }
  return out;
}
