import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { commands } from './commands.js';
import { BackupJob } from './jobs/backup-job.js';
import { BuildJob } from './jobs/build-job.js';
import { ExportJob } from './jobs/export-job.js';
import { eachName } from './lib/batch.js';

const UPLOADS = path.resolve('uploads');

export const app = express();
app.use(express.json());
app.use(commands);

app.post('/backups', (req, res) => {
  new BackupJob(req.body.target).start();
  res.status(202).json({ queued: true });
});

app.get('/exports', (req, res) => {
  const job = new ExportJob();
  job.configure(req);
  res.type('text/csv').send(job.read());
});

app.post('/builds', (req, res) => {
  new BuildJob().run();
  res.sendStatus(202);
});

app.post('/uploads/cleanup', (req, res) => {
  eachName(req.body.names, (name) => fs.unlinkSync(path.join(UPLOADS, name)));
  res.sendStatus(204);
});

app.post('/uploads/bundle', (req, res) => {
  const files = req.body.files.map((file) => fs.readFileSync(path.join(UPLOADS, file)));
  // path.basename() keeps each thumbnail inside the directory.
  const thumbnails = req.body.files.map((file) =>
    fs.readFileSync(path.join(UPLOADS, 'thumbs', path.basename(file))),
  );
  res.json({ files: files.length, thumbnails: thumbnails.length });
});

app.post('/webhooks/ping', async (req, res) => {
  for (const url of req.body.urls) await fetch(url);
  res.sendStatus(204);
});
