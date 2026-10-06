import { useEffect, useState } from 'react';

// Transient "copied" confirmation for one-click copy buttons: copy(text) flips copied on for
// resetMs so a button can relabel itself; a failed copy just leaves the label unchanged instead
// of surfacing an error.
export function useCopied(resetMs = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), resetMs);
    return () => window.clearTimeout(timer);
  }, [copied, resetMs]);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return { copied, copy };
}
