import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getConfig } from "@/lib/config";

// Test-only page: causes exactly one img-src violation. 404 unless fixtures are enabled.
export default async function CspViolationFixture() {
  await connection();
  if (!getConfig().fixturesEnabled) notFound();
  return (
    <main>
      <p>CSP fixture</p>
      <img src="http://blocked.fixture.test:3013/pixel.png" alt="" width={1} height={1} />
    </main>
  );
}
