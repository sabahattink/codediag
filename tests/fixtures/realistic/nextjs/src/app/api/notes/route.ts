import { z } from 'zod';
import { auth } from '../../../lib/auth';

const noteSchema = z.object({ title: z.string().min(1), body: z.string() });

export async function GET(): Promise<Response> {
  return Response.json([]);
}

export async function POST(request: Request): Promise<Response> {
  const session = await auth(request);
  if (!session) return new Response(null, { status: 401 });
  const parsed = noteSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json(parsed.error.flatten(), { status: 400 });
  return Response.json({ ...parsed.data, owner: session.userId }, { status: 201 });
}
