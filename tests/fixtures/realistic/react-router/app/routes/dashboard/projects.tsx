import { Link } from 'react-router';
import { userContext } from '~/context';
import { listProjects } from '~/models/project.server';
import type { Route } from './+types/projects';

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  return { projects: await listProjects(user.id) };
}

export default function Projects({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Projects</h1>
      <Link to="new">New project</Link>
      <ul>
        {loaderData.projects.map((project) => (
          <li key={project.id}>
            <Link to={project.id}>{project.name}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
