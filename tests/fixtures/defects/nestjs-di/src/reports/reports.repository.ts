export abstract class ReportsRepository {
  abstract find(id: string): Promise<unknown>;
}
