import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeNestjsApi } from "../src/analyzers/nestjs-api.js";
import { createScanContext } from "../src/core/scan-context.js";

async function analyze(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "codediag-nest-security-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0" } }),
    );
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return await analyzeNestjsApi(createScanContext(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rulesAndMessages(result: Awaited<ReturnType<typeof analyze>>) {
  return result.issues
    .filter((issue) =>
      ["missing-guard", "missing-dto", "dto-not-validated"].includes(
        issue.rule,
      ),
    )
    .map((issue) => `${issue.rule}: ${issue.message}`);
}

const DTO = [
  'import { IsString } from "class-validator";',
  "export class CreateOrderDto {",
  "  @IsString() item!: string;",
  "}",
].join("\n");

const ORDERS_CONTROLLER = [
  '@ApiTags("orders")',
  '@Controller({ path: "orders", version: "1" })',
  "export class OrdersController {",
  "  @Post()",
  "  create(@Body() dto: CreateOrderDto): Order { return dto as Order; }",
  "  @Public()",
  '  @Post("quote")',
  "  quote(@Body() dto: CreateOrderDto): Quote { return quote(dto); }",
  "}",
].join("\n");

test("global guards and public opt-outs replace per-endpoint guards", async () => {
  const result = await analyze({
    "src/main.ts": [
      "async function bootstrap() {",
      "  const app = await NestFactory.create(AppModule);",
      "  app.useGlobalGuards(new JwtAuthGuard(reflector));",
      "  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));",
      "}",
    ].join("\n"),
    "src/auth/public.decorator.ts": [
      'export const IS_PUBLIC_KEY = "isPublic";',
      "export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);",
    ].join("\n"),
    "src/orders/create-order.dto.ts": DTO,
    "src/orders/orders.controller.ts": ORDERS_CONTROLLER,
  });

  assert.deepEqual(rulesAndMessages(result), []);
});

test("APP_GUARD providers count as global guards", async () => {
  const result = await analyze({
    "src/app.module.ts": [
      "@Module({",
      "  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],",
      "})",
      "export class AppModule {}",
    ].join("\n"),
    "src/orders/create-order.dto.ts": DTO,
    "src/orders/orders.controller.ts": ORDERS_CONTROLLER.replace(
      "  @Public()\n",
      "",
    ),
    "src/main.ts": "app.useGlobalPipes(new ValidationPipe());\n",
  });

  assert.deepEqual(rulesAndMessages(result), []);
});

test("without global guards only explicitly public endpoints are exempt", async () => {
  const result = await analyze({
    "src/main.ts": "app.useGlobalPipes(new ValidationPipe());\n",
    "src/auth/skip-auth.decorator.ts":
      "export const SkipAuth = () => SetMetadata('skipAuth', true);\n",
    "src/orders/create-order.dto.ts": DTO,
    "src/orders/orders.controller.ts": ORDERS_CONTROLLER.replace(
      "@Public()",
      "@SkipAuth()",
    ),
  });

  assert.deepEqual(rulesAndMessages(result), [
    "missing-guard: POST /orders has no auth guard",
  ]);
});

test("composite decorators built with UseGuards count as guards", async () => {
  const result = await analyze({
    "src/auth/auth.decorator.ts": [
      "export function Auth(...roles: Role[]) {",
      "  return applyDecorators(SetMetadata('roles', roles), UseGuards(JwtGuard, RolesGuard));",
      "}",
    ].join("\n"),
    "src/admin.controller.ts": [
      '@Controller("admin")',
      "export class AdminController {",
      '  @Auth("admin")',
      '  @Delete("cache")',
      "  clear(): void {}",
      "}",
    ].join("\n"),
  });

  assert.deepEqual(rulesAndMessages(result), []);
});

test("request bodies need DTO classes, not structural types", async () => {
  const result = await analyze({
    "src/main.ts": "app.useGlobalPipes(new ValidationPipe());\n",
    "src/users/user.types.ts":
      "export interface CreateUserInput { name: string }\n",
    "src/users/users.controller.ts": [
      '@UseGuards(JwtGuard) @Controller("users")',
      "export class UsersController {",
      "  @Post() a(@Body() body: Record<string, any>): void {}",
      '  @Put(":id") b(@Body() body: CreateUserInput): void {}',
      '  @Patch(":id") c(@Body() body: { name: string }): void {}',
      '  @Post("logout") d(): void {}',
      '  @Post("bulk") e(@Body() items: CreateUserDto[]): void {}',
      "}",
    ].join("\n"),
  });

  assert.deepEqual(rulesAndMessages(result), [
    "missing-dto: POST /users uses Record<string, any> for its request body; declare a DTO class",
    "missing-dto: PUT /users/:id uses interface CreateUserInput for its request body; only classes can be validated at runtime",
    "missing-dto: PATCH /users/:id uses { name: string } for its request body; declare a DTO class",
  ]);
});

test("DTO classes without any ValidationPipe are reported once", async () => {
  const result = await analyze({
    "src/orders/create-order.dto.ts": DTO,
    "src/orders/orders.controller.ts": ORDERS_CONTROLLER,
  });

  assert.deepEqual(
    result.issues
      .filter((issue) => issue.rule === "dto-not-validated")
      .map(({ file, line }) => ({ file, line })),
    [{ file: "src/orders/orders.controller.ts", line: 4 }],
  );
});

test("controller object arguments and route arrays produce real paths", async () => {
  const result = await analyze({
    "src/main.ts": "app.useGlobalPipes(new ValidationPipe());\n",
    "src/files.controller.ts": [
      '@Controller({ path: ["files", "documents"], version: "2" })',
      "export class FilesController {",
      '  @Delete(["purge", "clear"]) purge(): void {}',
      "}",
    ].join("\n"),
  });

  assert.deepEqual(rulesAndMessages(result), [
    "missing-guard: DELETE /files/purge has no auth guard",
  ]);
});
