import { describe, expect, it } from "vitest";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3000";

describe.skipIf(!process.env.E2E_BASE_URL)("tRPC over HTTP", () => {
  it("rejects anonymous mutations", async () => {
    const response = await fetch(`${baseUrl}/api/trpc/post.create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { name: "Hello" } }),
    });
    expect(response.status).toBe(401);
  });
});
