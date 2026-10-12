import type {
  TransactionPorts,
  UnitOfWork,
} from "../../application/ports/unit-of-work.js";

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly ports: TransactionPorts) {}

  async execute<T>(
    operation: (ports: TransactionPorts) => Promise<T>,
  ): Promise<T> {
    return operation(this.ports);
  }
}
