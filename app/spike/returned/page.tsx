export const metadata = { title: "Approved · SafeDeal spike" };

// Return page for `npm run spike` approval links. Dev only; nothing happens here.
export default async function SpikeReturned({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const { result } = await searchParams;
  const cancelled = result === "cancelled";
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-bold">{cancelled ? "Cancelled" : "Approved"}</h1>
      <p>
        {cancelled
          ? "You cancelled on PayPal. Go back to the terminal and type skip, or run the spike again."
          : "PayPal has your approval. Go back to the terminal and press Enter."}
      </p>
    </main>
  );
}
