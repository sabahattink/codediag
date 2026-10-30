# notes-api

A notes API in the layout `fastify-cli` generates: shared plugins in `src/plugins` and routes in `src/routes`, both loaded with `@fastify/autoload`. This fixture is used by CodeDiag's benchmark tests to make sure autoloaded Fastify projects get their directory prefixes and autohooks and produce no false findings.

## Development

Install dependencies, set `JWT_SECRET`, run the tests, and start the server with `npm run dev`.
