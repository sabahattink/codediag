import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { createContext } from './context.js';
import { appRouter } from './router.js';

createHTTPServer({ router: appRouter, createContext }).listen(Number(process.env.PORT ?? 3000));
