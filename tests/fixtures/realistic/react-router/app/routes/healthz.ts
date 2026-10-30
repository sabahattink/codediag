import { db } from '~/db.server';

/** Resource route for the load balancer: no UI, no session. */
export async function loader() {
  try {
    await db.user.findFirst({ select: { id: true } });
    return Response.json({ status: 'ok' });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 });
  }
}
