# taskboard

A small task tracker built with SvelteKit, Drizzle, and Superforms. Sessions are stored in Postgres, the handle hook in `src/hooks.server.ts` redirects anonymous visitors away from the app and rejects anonymous API calls, and every action and endpoint validates its input with Zod. This fixture is used by CodeDiag's benchmark tests to make sure well-built SvelteKit apps score well and produce no critical findings.

## Development

Copy `.env.example` to `.env`, point `DATABASE_URL` at a Postgres database, run `npx drizzle-kit push`, and start the app with `npm run dev`. Run the tests with `npm test`.
