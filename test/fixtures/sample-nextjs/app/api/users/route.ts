import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  return NextResponse.json(await db.users.findMany());
}

// No session check and no validation of the parsed body (2 warnings).
export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json(await db.users.create({ data: body }), { status: 201 });
}
