import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { createCaller } from "~/server/api/root";

vi.mock("~/server/auth", () => ({ auth: vi.fn() }));

const db = { post: { findMany: vi.fn().mockResolvedValue([]) } };

describe("procedure builders", () => {
  it("lets anonymous callers read public procedures", async () => {
    const caller = createCaller({ db, session: null, headers: new Headers() } as never);
    await expect(caller.post.latest()).resolves.toEqual([]);
  });

  it("rejects anonymous callers of protected procedures", async () => {
    const caller = createCaller({ db, session: null, headers: new Headers() } as never);
    await expect(caller.user.me()).rejects.toBeInstanceOf(TRPCError);
  });
});
