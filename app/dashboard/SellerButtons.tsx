"use client";

import { useState } from "react";
import { Button } from "../components/ui";

export function SellerLogout() {
  return (
    <button
      type="button"
      className="text-sm text-neutral-600 underline dark:text-neutral-400"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.href = "/login";
      }}
    >
      Log out
    </button>
  );
}

/** Archive a finished deal, or bring an archived one back. */
export function ArchiveButton({ reference, archived }: { reference: string; archived: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch(`/api/dashboard/deals/${reference}/archive`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: !archived }),
          });
          if (res.ok) {
            window.location.reload();
            return;
          }
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? "Could not change this deal. Try again.");
          setBusy(false);
        }}
      >
        {busy ? "Saving…" : archived ? "Move back to Finished" : "Archive"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
