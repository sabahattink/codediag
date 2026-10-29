import { UsersService } from "./users.service";

describe("UsersService", () => {
  it("creates users", () => {
    const service = new UsersService();
    expect(service.create({ email: "ada@example.com", name: "Ada" }).id).toBe(1);
  });
});
