const express = require('express');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const { spawn } = require('node:child_process');

const router = express.Router();
const settings = { ui: {}, mail: {} };

router.use(session({ secret: process.env.SESSION_SECRET, cookie: { secure: false } }));

router.post('/login', requireAuth, validateLogin, (req, res) => {
  const token = jwt.sign({ sub: req.user.id }, process.env.JWT_SECRET);
  res.cookie('session_token', token);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const claims = jwt.verify(req.get('authorization'), process.env.JWT_SECRET, {
    algorithms: ['HS256', 'none'],
    ignoreExpiration: true,
  });
  res.json(claims);
});

router.post('/preview', requireAuth, validateTemplate, (req, res) => {
  res.send(ejs.render(req.body.template, { user: req.user }));
});

router.put('/settings', requireAuth, validateSettings, (req, res) => {
  const { section, key, value } = req.body;
  settings[section][key] = value;
  res.sendStatus(204);
});

router.post('/archive', requireAuth, validateArchive, (req, res) => {
  spawn('tar', ['-czf', 'archive.tgz', req.body.path], { shell: true });
  res.sendStatus(202);
});

module.exports = router;
