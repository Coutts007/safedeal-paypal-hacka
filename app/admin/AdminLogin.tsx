"use client";

import { useState } from "react";
import { Button, Card, Field, inputClass, Notice } from "../components/ui";

export default function AdminLogin({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!configured) {
    return (
      <Notice tone="error">
        The reviewer page is off: ADMIN_PASSWORD is not set on the server.
      </Notice>
    );
  }
  return (
    <Card title="Reviewer login">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const res = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          setBusy(false);
          if (res.ok) return window.location.reload();
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? "Could not log in");
        }}
      >
        <Field label="Admin password">
          <input
            type="password"
            className={inputClass}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Log in"}
        </Button>
      </form>
    </Card>
  );
}
