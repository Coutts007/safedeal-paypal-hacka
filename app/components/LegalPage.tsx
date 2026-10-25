import Link from "next/link";
import { Card } from "./ui";

/** A short plain-language page for the privacy notice and the terms (Log in with PayPal needs both). */
export function LegalPage({
  title,
  sections,
}: {
  title: string;
  sections: { heading: string; body: string[] }[];
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-3xl font-bold">
          SafeDeal
        </Link>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          SafeDeal is a hackathon demo that runs on the PayPal sandbox only. No real money moves.
        </p>
      </header>
      {sections.map((s) => (
        <Card key={s.heading} title={s.heading}>
          <div className="flex flex-col gap-2 text-sm">
            {s.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </Card>
      ))}
    </main>
  );
}
