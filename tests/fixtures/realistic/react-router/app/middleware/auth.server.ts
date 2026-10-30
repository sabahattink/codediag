import type { MiddlewareFunction } from 'react-router';
import { userContext } from '~/context';
import { getUser, loginRedirect } from '~/session.server';

/** Signs the request in before any loader or action of the routes below it. */
export const requireUserMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const user = await getUser(request);
  if (!user) throw loginRedirect(request);
  context.set(userContext, user);
};
