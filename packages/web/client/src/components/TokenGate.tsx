import { useState } from 'react';
import { api, getToken, setToken } from '../api.js';

/**
 * Sign-in gate for token-mode (remote/phone) deployments. Shown after a request 401s (so
 * local none-mode never sees it), or when the stored token turned out to be a service token
 * (`reason` says so). Validates the pasted token via /auth/whoami — a service token is an
 * agent's credential and is refused, since every human action would 403 with it — then
 * reloads so every hook (including the SSE stream) re-initialises with the token.
 */
export const USER_TOKEN_HINT = 'Paste a user token: npm run token -- --label <name> --email <you> (without --service).';

export function TokenGate({ reason }: { reason?: string | undefined } = {}) {
  const [value, setValue] = useState(getToken() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    setToken(value);
    try {
      const who = await api.whoami();
      if (who.kind === 'anon') {
        setToken(null);
        setError('That token was not accepted.');
        setBusy(false);
      } else if (who.kind === 'service') {
        setToken(null);
        setError(`That is the service token '${who.label ?? ''}' — it is for supervisors and agents and cannot approve, send back or edit. ${USER_TOKEN_HINT}`);
        setBusy(false);
      } else {
        location.reload();
      }
    } catch {
      setError('Could not reach the server to verify the token.');
      setBusy(false);
    }
  };

  return (
    <div className="af-overlay">
      <div className="af-modal" style={{ width: 420, maxWidth: '95vw', padding: 22 }}>
        <h3 style={{ marginTop: 0 }}>Sign in</h3>
        <p style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.5 }}>
          This board requires an access token. Paste the token you minted with <span className="mono">npm run token</span>.
        </p>
        {reason && <p className="af-err" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{reason}</p>}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder="Access token"
          style={{ width: '100%', height: 40, padding: '0 12px', marginTop: 4 }}
        />
        {error && <div className="af-err" style={{ marginTop: 8, fontSize: 12.5 }}>{error}</div>}
        <button className="af-btn-primary" style={{ marginTop: 14 }} onClick={() => void submit()} disabled={busy}>
          {busy ? 'Verifying…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
