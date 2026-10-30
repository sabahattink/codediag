import { describe, expect, it, vi } from 'vitest';

vi.mock('~/session.server', () => ({ requireUserId: vi.fn(async () => 'u1') }));
vi.mock('~/models/project.server', () => ({ addTask: vi.fn(), getProject: vi.fn() }));

const { action } = await import('./tasks');

describe('POST /api/projects/:projectId/tasks', () => {
  it('rejects an empty title', async () => {
    const request = new Request('http://localhost/api/projects/p1/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '' }),
    });
    const response = await action({ request, params: { projectId: 'p1' }, context: {} } as never);
    expect(response.status).toBe(400);
  });
});
