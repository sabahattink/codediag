import { describe, expect, it, vi } from "vitest";

import { GET } from "./route";

vi.mock("~/server/db", () => ({ db: { $queryRaw: vi.fn().mockResolvedValue([]) } }));

describe("health route", () => {
  it("reports ok when the database answers", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
