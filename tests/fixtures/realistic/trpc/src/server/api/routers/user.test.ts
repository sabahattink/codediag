import { describe, expect, it, vi } from "vitest";

import { createCaller } from "~/server/api/root";

vi.mock("~/server/auth", () => ({ auth: vi.fn() }));

function callerFor(role: "member" | "admin") {
  return createCaller({
    db: { user: { update: vi.fn().mockResolvedValue({}) } },
    session: { user: { id: "user-1", role }, expires: "2099-01-01" },
    headers: new Headers(),
  } as never);
}

describe("user router", () => {
  it("only lets administrators change roles", async () => {
    await expect(
      callerFor("member").user.setRole({ userId: "cl000000000000000000000000", role: "admin" }),
    ).rejects.toThrow("FORBIDDEN");
  });

  it("trims new display names", async () => {
    await expect(callerFor("member").user.updateName({ name: " Ada " })).resolves.toEqual({});
  });
});
