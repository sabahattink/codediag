import { db } from "~/server/db";

export async function GET() {
  await db.$queryRaw`SELECT 1`;
  return Response.json({ status: "ok" });
}
