import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { id } = await params;

  const job = await prisma.generationJob.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      provider: true,
      prompt: true,
      resultUrl: true,
      error: true,
      createdAt: true,
    },
  });

  // Same 404 for "doesn't exist" and "isn't yours" — don't leak which one.
  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: "Generation not found." }, { status: 404 });
  }

  const { userId: _userId, ...visible } = job;
  return NextResponse.json(visible);
}
