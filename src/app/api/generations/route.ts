import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const MAX_JOBS = 50;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const jobs = await prisma.generationJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: MAX_JOBS,
    select: {
      id: true,
      status: true,
      provider: true,
      prompt: true,
      resultUrl: true,
      error: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ jobs });
}
