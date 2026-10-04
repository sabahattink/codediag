import { Router } from 'express';

const DOCS_DIR = new URL('../../docs', import.meta.url).pathname;
const STATUS_API = 'https://status.example.com';

const router = Router();

// Express refuses `..` segments when a root directory is given.
router.get('/files/:name', (req, res) => {
  res.sendFile(req.params.name, { root: DOCS_DIR });
});

router.get('/legacy/:slug', (req, res) => {
  res.redirect(301, `/docs/files/${encodeURIComponent(req.params.slug)}.md`);
});

router.get('/status/:service', async (req, res) => {
  const response = await fetch(`${STATUS_API}/services/${encodeURIComponent(req.params.service)}`);
  res.json(await response.json());
});

export default router;
