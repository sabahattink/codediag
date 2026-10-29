const { describe, it, expect } = require("vitest");
const { slugify } = require("./slugify");

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify(" Hello World ")).toBe("hello-world");
  });
});
