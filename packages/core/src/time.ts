// single source of timestamps so updated_at and activity.created_at match per op
export function nowIso(): string { return new Date().toISOString(); }
