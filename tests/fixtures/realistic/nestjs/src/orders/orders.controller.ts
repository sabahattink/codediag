import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateOrderDto } from './create-order.dto';
import { Order } from './order.entity';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(): Order[] {
    return this.orders.list();
  }

  @Post()
  create(@Body() input: CreateOrderDto): Order {
    return this.orders.create(input);
  }

  @Delete(':id')
  remove(@Param('id') id: string): void {
    this.orders.remove(id);
  }
}
