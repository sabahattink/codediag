# taskboard

A project and task tracker built with React Router v7 in framework mode. Routes are declared in `app/routes.ts`; the dashboard layout's middleware signs users in before any project route runs, and the JSON API under `/api` checks the session itself. This fixture is a small but realistic app used by CodeDiag's benchmark tests to make sure well-built projects score well and produce no critical findings.

## Development

Copy `.env.example` to `.env`, push the Prisma schema, run the tests, and start the dev server with `npm run dev`.
