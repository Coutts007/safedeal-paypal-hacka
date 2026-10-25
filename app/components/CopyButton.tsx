"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

/** Copy where the Clipboard API is missing or refused (plain http, older phone browsers). */
function copyFallback(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * A button that copies `text` and says so: "Copied ✓" for a few seconds, announced to screen
 * readers. If the browser will not copy, it says how to copy by hand instead.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyFallback(text);
    }
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <div className="flex flex-col gap-1">
      <Button variant={state === "copied" ? "success" : "secondary"} onClick={() => void copy()}>
        {state === "copied" ? "Copied ✓" : label}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className="text-xs text-neutral-600 dark:text-neutral-400"
      >
        {state === "copied" && "The link is copied. Paste it in your chat with the buyer."}
        {state === "failed" &&
          "This browser would not copy. Press and hold the link above to copy it."}
      </span>
    </div>
  );
}
