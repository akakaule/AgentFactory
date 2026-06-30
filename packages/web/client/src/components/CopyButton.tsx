import { useState } from 'react';

/**
 * Copies `body` to the clipboard and flashes "Copied ✓" for ~2s. Disabled when `body` is empty,
 * so callers can pass a composed string and let the button gate itself. Clipboard failures
 * (e.g. an insecure context) are swallowed — the source text stays on screen for a manual copy.
 */
export function CopyButton({ body, label, className = 'af-mini' }: { body: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button className={className} disabled={!body} onClick={copy}>
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
