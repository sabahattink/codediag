import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

describe('OrdersController', () => {
  it('lists orders', () => {
    expect(new OrdersController(new OrdersService()).list()).toEqual([]);
  });
});
