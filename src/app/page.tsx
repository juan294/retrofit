import { connection } from "next/server";

export default async function Home() {
  // Render per request so that each response carries its own CSP nonce.
  await connection();
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-4xl font-semibold">Retrofit</h1>
      <p className="mt-4 text-lg" style={{ color: "var(--color-muted)" }}>
        An agent on your own website that can take the order, and it is yours to keep.
      </p>
    </main>
  );
}
