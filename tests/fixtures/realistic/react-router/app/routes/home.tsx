import { Link } from 'react-router';
import type { Route } from './+types/home';

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Taskboard' }];
}

export default function Home() {
  return (
    <main>
      <h1>Taskboard</h1>
      <p>Plan projects and keep track of their tasks.</p>
      <Link to="/projects">Open your projects</Link>
    </main>
  );
}
