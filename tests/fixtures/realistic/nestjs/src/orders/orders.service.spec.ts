import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  it('creates orders', () => {
    const service = new OrdersService();
    expect(service.create({ sku: 'A-1', quantity: 2 }).quantity).toBe(2);
  });
});
