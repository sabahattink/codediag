import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  task: { create: vi.fn() },
}));
vi.mock('~/db.server', () => ({ db }));

const { addTask } = await import('./project.server');

describe('addTask', () => {
  it('does not add tasks to another owner’s project', async () => {
    db.project.findFirst.mockResolvedValueOnce(null);
    expect(await addTask('p1', 'intruder', { title: 'Ship it' })).toBeNull();
    expect(db.task.create).not.toHaveBeenCalled();
  });
});
