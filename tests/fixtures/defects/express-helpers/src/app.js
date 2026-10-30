const express = require('express');
const { Pool } = require('pg');
const { convert } = require('./lib/convert');
const { sendAvatar, sendUpload } = require('./lib/files');
const { requestedUrl } = require('./lib/input');
const { readPage } = require('./lib/pages');
const ReportService = require('./services/reports');

const app = express();
const reports = new ReportService(new Pool());

app.get('/uploads/:name', (req, res) => sendUpload(res, req.params.name));

app.get('/avatars/:name', (req, res) => sendAvatar(res, req.params.name));

app.post('/convert', (req, res) => {
  res.json({ output: convert(req.body.format) });
});

app.get('/reports', async (req, res) => {
  res.json(await reports.find(req.query.id));
});

app.get('/proxy', async (req, res) => {
  const upstream = await fetch(requestedUrl(req));
  res.json({ status: upstream.status });
});

app.get('/welcome', (req, res) => res.type('html').send(readPage('welcome')));

module.exports = app;
