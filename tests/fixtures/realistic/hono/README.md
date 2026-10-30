# bookshelf-api

A bookshelf API built with Hono, Zod validators, and JWT authentication. This fixture is a small but realistic service used by CodeDiag's benchmark tests to make sure well-built Hono projects score well and produce no critical findings.

## Development

Copy `.env.example` to `.env`, set a `JWT_SECRET` of at least 32 characters, run the tests, and start the server with `npm run dev`.
