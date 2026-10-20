export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-10">
      <h1 className="text-3xl font-bold">SafeDeal</h1>
      <p className="text-lg">
        Agreed a deal in chat? Pay with PayPal and the money stays on hold until delivery is proven.
        If the seller never ships, the hold is released automatically.
      </p>
      <p className="text-sm opacity-70">
        Sandbox demo under construction. The chat-to-deal flow arrives in Phase 4.
      </p>
    </main>
  );
}
