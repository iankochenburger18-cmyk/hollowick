import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();

  return (
    <main>
      <h1>Hollowick</h1>
      <p>AI video generation, aggregated across providers.</p>
      {session ? (
        <p>
          Signed in as {session.user.email}. <Link href="/dashboard">Go to dashboard</Link>
        </p>
      ) : (
        <p>
          <Link href="/signin">Sign in</Link> or <Link href="/signup">create an account</Link>.
        </p>
      )}
    </main>
  );
}
