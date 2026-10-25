/**
 * "Log in with PayPal" (Phase 6b). A plain link to the start route, which sends the browser to
 * PayPal's own sign-in page; SafeDeal never sees the PayPal password.
 */
export function PaypalLoginButton() {
  return (
    <a
      href="/api/auth/paypal/start"
      className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#0070ba] px-4 py-2 font-medium text-white transition select-none hover:bg-[#005ea6] focus-visible:ring-2 focus-visible:ring-[#0070ba] focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.98] active:bg-[#003087]"
    >
      Log in with PayPal
    </a>
  );
}
