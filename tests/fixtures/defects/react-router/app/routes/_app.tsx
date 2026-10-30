import { json, type LoaderFunctionArgs } from '@remix-run/node';
import { Outlet } from '@remix-run/react';
import { requireUserId } from '../session.server';

// Hides the notes UI from anonymous visitors, but protects no child loader or action.
export async function loader({ request }: LoaderFunctionArgs) {
  return json({ userId: await requireUserId(request) });
}

export default function AppLayout() {
  return <Outlet />;
}
