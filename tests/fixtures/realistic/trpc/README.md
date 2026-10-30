# t3-notes

A notes application built on the T3 stack: the Next.js App Router, tRPC, Auth.js, and Prisma. This fixture is a small but realistic project used by CodeDiag's benchmark tests to make sure well-built tRPC applications score well and produce no findings.

## Development

Copy `.env.example` to `.env`, fill in the Discord OAuth credentials and the database URL, push the schema with `npm run db:push`, run the tests, and start the app with `npm run dev`.
