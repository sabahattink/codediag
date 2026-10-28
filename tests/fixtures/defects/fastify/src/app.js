const fastify = require('fastify');

const app = fastify({ logger: true });

async function adminRoutes(admin) {
  admin.delete('/users/:id', async () => ({ deleted: true }));
}

async function accountRoutes(account) {
  account.addHook('onRequest', account.authenticate);
  account.patch('/profile', async (request) => request.body);
}

app.register(adminRoutes, { prefix: '/admin' });
app.register(accountRoutes, { prefix: '/account' });

app.post('/webhooks', { schema: { body: { type: 'object' } } }, async () => ({ received: true }));
