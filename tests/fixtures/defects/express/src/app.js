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

app.get('/download', (req, res) => {
  res.sendFile(req.query.file);
});

app.get('/preview', async (req, res) => {
  const page = await fetch(req.query.url);
  res.json({ status: page.status });
});

app.get('/login', (req, res) => {
  res.redirect(req.query.next);
});

app.get('/search', (req, res) => {
  res.send(`<h1>Results for ${req.query.q}</h1>`);
});
