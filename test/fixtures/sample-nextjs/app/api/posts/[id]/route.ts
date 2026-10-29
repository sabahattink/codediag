import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

const updatePost = z.object({ title: z.string().min(1) });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = updatePost.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(parsed.error.issues, { status: 400 });
  const { id } = await params;
  return NextResponse.json(await db.posts.update({ where: { id }, data: parsed.data }));
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  await db.posts.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
