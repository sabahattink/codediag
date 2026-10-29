import type { NextApiRequest, NextApiResponse } from "next";

// Legacy Pages Router handler: accepts POST bodies without auth or validation.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  const { message } = req.body;
  return res.status(201).json({ message });
}
