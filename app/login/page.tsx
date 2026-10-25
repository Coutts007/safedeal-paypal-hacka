import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PaypalLoginButton } from "../components/PaypalLogin";
import { Card, Notice } from "../components/ui";
import { currentAccount } from "../dashboard/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Log in · SafeDeal" };

const ERRORS: Record<string, string> = {
  cancelled: "You did not finish logging in with PayPal. Try again when you are ready.",
  expired: "That login took too long or was not started here. Please log in again.",
  email:
    "PayPal did not share your email address, which SafeDeal needs to pay you. Try again and allow it.",
  paypal: "PayPal could not complete the login just now. Please try again in a minute.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentAccount()) redirect("/dashboard");
  const error = ERRORS[(await searchParams).error ?? ""];
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-3xl font-bold">
          SafeDeal
        </Link>
        <p className="text-lg">Selling to many buyers? Keep every deal in one place.</p>
      </header>
      <Card title="Seller login">
        <div className="flex flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}
          <p className="text-sm">
            Log in with the PayPal account you get paid to. SafeDeal sees your name and PayPal
            email, never your PayPal password, and every deal you create pays out to that account.
          </p>
          <PaypalLoginButton />
          <p className="text-xs text-neutral-500">
            Sandbox demo: use a PayPal sandbox business account. Buyers do not need to log in; they
            use the private link you send them.
          </p>
        </div>
      </Card>
    </main>
  );
}
