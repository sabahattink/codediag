import { createMiddleware } from 'hono/factory';

type Role = 'reader' | 'moderator';

// Runs after the jwt() middleware, which stores the verified token payload.
export function requireRole(role: Role) {
  return createMiddleware(async (c, next) => {
    const payload: { roles?: Role[] } | undefined = c.get('jwtPayload');
    if (!payload?.roles?.includes(role)) {
      return c.json({ message: 'Forbidden' }, 403);
    }
    await next();
  });
}
