import { useState } from 'react';
import type { CredentialHealthView } from '../types.js';

const clock = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

/**
 * Board banner for workspace git credentials: a rejected PAT (its implementation work is held) or a
 * GitHub PAT about to expire. Credentials that work, or that could not be checked, stay quiet here —
 * the Workspaces dialog badges every one.
 */
export function CredentialAlerts({ health, onUpdatePat, onCheck }: {
  health: CredentialHealthView[];
  onUpdatePat: (workspace: string) => void;
  onCheck: (workspace: string) => Promise<void>;
}) {
  const [checking, setChecking] = useState<string | null>(null);
  const alerts = health.filter((h) => h.state === 'failing' || h.state === 'expiring');
  if (alerts.length === 0) return null;
  const check = (workspace: string) => {
    setChecking(workspace);
    void onCheck(workspace).finally(() => setChecking(null));
  };
  return (
    <section className="af-cred-alerts" aria-label="Credential alerts">
      {alerts.map((h) => (
        <div key={h.workspace} className={`af-cred-alert ${h.state}`}>
          {h.state === 'failing' ? (
            <span title={h.error ?? undefined}>
              <b>{h.workspace}</b>: the git host rejected the PAT since {clock(h.failingSince ?? h.checkedAt)}. Implementation tasks are held.
            </span>
          ) : (
            <span>
              <b>{h.workspace}</b>: the PAT expires in {h.expiresInDays} {h.expiresInDays === 1 ? 'day' : 'days'} ({day(h.expiresAt!)}).
            </span>
          )}
          <span className="grow"></span>
          <button className="af-mini" onClick={() => onUpdatePat(h.workspace)}>Update PAT</button>
          {h.state === 'failing' && (
            <button className="af-mini" disabled={checking === h.workspace} onClick={() => check(h.workspace)}>
              {checking === h.workspace ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
