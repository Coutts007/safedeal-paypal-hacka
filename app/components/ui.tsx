// Small shared UI pieces for the Deal Room and the create form. Mobile first (works at 360 px).

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      {title && (
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-neutral-500 uppercase">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** "success": a secondary action that just worked (e.g. "Copied ✓"). */
  variant?: "primary" | "secondary" | "danger" | "success";
}) {
  // Each variant keeps readable text on hover and when pressed, in light and dark mode, and shows
  // a press (darker background, slight shrink) so a tap visibly lands.
  const styles = {
    primary:
      "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-emerald-300 dark:disabled:bg-emerald-900 dark:disabled:text-emerald-300",
    secondary:
      "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 active:bg-neutral-200 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 dark:active:bg-neutral-600",
    success:
      "border border-emerald-500 bg-emerald-50 text-emerald-800 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-200",
    danger:
      "border border-red-300 bg-white text-red-700 hover:bg-red-50 active:bg-red-100 dark:border-red-800 dark:bg-neutral-800 dark:text-red-300 dark:hover:bg-red-950 dark:active:bg-red-900",
  }[variant];
  return (
    <button
      {...props}
      className={`min-h-11 w-full rounded-xl px-4 py-2 font-medium transition select-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 disabled:active:scale-100 ${styles} ${props.className ?? ""}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "min-h-11 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 focus:border-emerald-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";

export function Notice({
  tone,
  children,
}: {
  tone: "error" | "info" | "ok";
  children: React.ReactNode;
}) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800",
    info: "border-sky-200 bg-sky-50 text-sky-900",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-xl border px-3 py-2 text-sm ${styles}`}
    >
      {children}
    </p>
  );
}

const NAIROBI = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Times are shown in Nairobi time, whatever the device's time zone. */
export const nairobi = (iso: string) => `${NAIROBI.format(new Date(iso))} EAT`;

export const kes = (n: number) => `KES ${n.toLocaleString("en-KE")}`;
