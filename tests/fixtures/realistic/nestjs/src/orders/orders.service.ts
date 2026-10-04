import { Injectable } from '@nestjs/common';
import { CreateOrderDto } from './create-order.dto';
import { Order } from './order.entity';

@Injectable()
export class OrdersService {
  private readonly orders = new Map<string, Order>();

  list(): Order[] {
    return [...this.orders.values()];
  }

  create(input: CreateOrderDto): Order {
    const order = new Order(String(this.orders.size + 1), input.sku, input.quantity);
    this.orders.set(order.id, order);
    return order;
  }

  remove(id: string): void {
    this.orders.delete(id);
  }
}
