import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.ts'),
  route('healthz', 'routes/healthz.ts'),
  layout('routes/dashboard/layout.tsx', [
    ...prefix('projects', [
      index('routes/dashboard/projects.tsx'),
      route('new', 'routes/dashboard/new-project.tsx'),
      route(':projectId', 'routes/dashboard/project.tsx'),
    ]),
  ]),
  ...prefix('api', [route('projects/:projectId/tasks', 'routes/api/tasks.ts')]),
] satisfies RouteConfig;
