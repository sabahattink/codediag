import { json } from '@remix-run/node';
import { Outlet, useLoaderData } from '@remix-run/react';
import { db } from '../db.server';

export async function loader() {
  return json({ notes: db.list() });
}

export default function Notes() {
  const { notes } = useLoaderData<typeof loader>();
  return (
    <div>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
      <Outlet />
    </div>
  );
}
