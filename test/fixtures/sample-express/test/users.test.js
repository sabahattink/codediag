const { describe, it, expect } = require("vitest");
const db = require("../src/db");

describe("db", () => {
  it("inserts rows", async () => {
    expect((await db.insert({ name: "Ada" })).id).toBe("1");
  });
});
