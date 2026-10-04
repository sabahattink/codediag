import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { errorHandler } from './middleware/errors.js';
import docs from './routes/docs.js';
import products from './routes/products.js';

export const app = express();

app.use(helmet());
app.use(cors({ origin: ['https://shop.example.com'] }));
app.use(rateLimit({ windowMs: 60_000, limit: 100 }));
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});
app.use('/docs', docs);
app.use('/products', products);
app.use(errorHandler);
