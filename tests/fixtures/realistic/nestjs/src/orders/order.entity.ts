export class Order {
  constructor(
    readonly id: string,
    readonly sku: string,
    readonly quantity: number,
  ) {}
}
