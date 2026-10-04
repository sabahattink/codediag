import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

const productSchema = z.object({ name: z.string().min(1), price: z.number().positive() });
const products: Array<z.infer<typeof productSchema>> = [];

const router = Router();

router.get('/', (_req, res) => {
  res.json(products);
});

router.use(requireAuth);

router.post('/', validateBody(productSchema), (req, res) => {
  products.push(req.body);
  res.status(201).json(req.body);
});

router.delete('/:index', (req, res) => {
  products.splice(Number(req.params.index), 1);
  res.sendStatus(204);
});

export default router;
