const express = require('express');
const { exec } = require('node:child_process');

const app = express();
const userRoutes = express.Router();

userRoutes.delete('/users/:id', (req, res) => res.sendStatus(204));

app.post('/run', requireAuth, validateCommand, (req, res) => {
  const cmd = req.query.cmd;
  exec(cmd);
  res.send('ok');
});

app.get('/users/:id', async (req, res) => {
  const myDb = getDb();
  res.json(await myDb.query('SELECT * FROM users WHERE id = ' + req.params.id));
});

app.use('/admin', userRoutes);
