import { json, type ActionFunctionArgs } from '@remix-run/node';
import { db } from '../db.server';

// A resource route that trusts any caller: no signature check, no schema.
export async function action({ request }: ActionFunctionArgs) {
  const event = await request.json();
  db.save(event.note);
  return json({ received: true });
}
