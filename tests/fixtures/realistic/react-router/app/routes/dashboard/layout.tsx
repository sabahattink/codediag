import { Form, NavLink, Outlet } from 'react-router';
import { userContext } from '~/context';
import { requireUserMiddleware } from '~/middleware/auth.server';
import type { Route } from './+types/layout';

export const middleware: Route.MiddlewareFunction[] = [requireUserMiddleware];

export async function loader({ context }: Route.LoaderArgs) {
  return { user: context.get(userContext) };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <header>
        <NavLink to="/projects">Projects</NavLink>
        <span>{loaderData.user.name}</span>
        <Form method="post" action="/logout">
          <button type="submit">Log out</button>
        </Form>
      </header>
      <Outlet />
    </div>
  );
}
