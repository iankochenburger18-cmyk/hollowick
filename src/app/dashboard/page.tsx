import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const session = await auth();
  if (!session) {
    redirect("/signin");
  }

  const creditBalance = await prisma.creditBalance.findUnique({
    where: { userId: session.user.id },
  });

  return (
    <main>
      <h1>Dashboard</h1>
      <p>Signed in as {session.user.email}</p>
      <p>Credit balance: {creditBalance?.balance ?? 0}</p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
