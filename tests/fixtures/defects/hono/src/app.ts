import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { z } from 'zod';

const app = new Hono();
const admin = new Hono();
const adminToken = bearerAuth({ token: process.env.ADMIN_TOKEN ?? '' });

admin.delete('/users/:id', (c) => c.json({ deleted: c.req.param('id') }));

app.route('/admin', admin);
// Registered after the mount above, so it never runs for the admin routes.
app.use('/admin/*', adminToken);

// Validates the id but not the body the handler reads.
app.patch('/account/:id', adminToken, zValidator('param', z.object({ id: z.string() })), async (c) =>
  c.json(await c.req.json()),
);

app.post('/webhooks', async (c) => c.json({ received: true }));

export default app;
