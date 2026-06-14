import { useState } from 'react';
import { api, getToken, setToken } from '../api.js';

/**
 * Sign-in gate for token-mode (remote/phone) deployments. Shown only after a request
 * 401s, so local none-mode never sees it. Validates the pasted token via /auth/whoami,
 * then reloads so every hook (including the SSE stream) re-initialises with the token.
 */
export function TokenGate() {
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
