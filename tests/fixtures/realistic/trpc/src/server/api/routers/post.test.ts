import { describe, expect, it, vi } from "vitest";

import { createCaller } from "~/server/api/root";

vi.mock("~/server/auth", () => ({ auth: vi.fn() }));

const member = { user: { id: "user-1", role: "member" }, expires: "2099-01-01" };

describe("post router", () => {
  it("creates posts for the signed-in user", async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: "Hello" });
    const caller = createCaller({
      db: { post: { create } },
      session: member,
      headers: new Headers(),
    } as never);

    await caller.post.create({ name: "  Hello " });

    expect(create).toHaveBeenCalledWith({
      data: { name: "Hello", createdBy: { connect: { id: "user-1" } } },
    });
  });

  it("does not delete other users' posts", async () => {
    const caller = createCaller({
      db: { post: { findUnique: vi.fn().mockResolvedValue({ createdById: "user-2" }) } },
      session: member,
      headers: new Headers(),
    } as never);

    await expect(caller.post.delete({ id: 7 })).rejects.toThrow("NOT_FOUND");
  });
});
