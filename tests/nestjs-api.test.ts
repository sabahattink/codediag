import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeNestjsApi } from "../src/analyzers/nestjs-api.js";

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "codediag-nestjs-"));
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
  );
  return directory;
}

test("NestJS analyzer recognizes class safeguards and documentation", async () => {
  const directory = createProject();
  try {
    writeFileSync(
      join(directory, "src", "users.controller.ts"),
      `
@Controller("users")
@UseGuards(AuthGuard)
@ApiTags("users")
class UsersController {
  @Post()
  create(@Body() input: CreateUserDto): Promise<User> {
    return service.create(input);
  }
}
`,
    );

    const result = await analyzeNestjsApi(directory);

    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
    assert.equal(result.summary, "1 endpoints across 1 controllers");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("NestJS analyzer reports unsafe endpoints with source locations", async () => {
  const directory = createProject();
  try {
    writeFileSync(
      join(directory, "src", "admin.controller.ts"),
      `
@Controller("admin")
class AdminController {
  @Post("users")
  create(@Body() input: any) {
    return input;
  }
}
`,
    );

    const result = await analyzeNestjsApi(directory);
    const rules = new Set(result.issues.map((issue) => issue.rule));

    assert.deepEqual(
      rules,
      new Set([
        "missing-guard",
        "missing-dto",
        "missing-swagger",
        "missing-return-type",
      ]),
    );
    for (const issue of result.issues) {
      assert.equal(issue.file, "src/admin.controller.ts");
      assert.equal(issue.line, 4);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("NestJS analyzer excludes controller fixtures in test directories", async () => {
  const directory = createProject();
  try {
    mkdirSync(join(directory, "tests"));
    writeFileSync(
      join(directory, "tests", "fixture.controller.ts"),
      '@Controller("fixture")\nclass FixtureController {\n  @Get() get() {}\n}\n',
    );

    const result = await analyzeNestjsApi(directory);

    assert.equal(result.score, 0);
    assert.equal(result.issues[0]?.rule, "no-controllers");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
