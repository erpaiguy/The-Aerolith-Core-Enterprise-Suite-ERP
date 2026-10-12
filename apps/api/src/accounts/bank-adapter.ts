// A live bank feed (docs/03-architecture.md §14): an Indian bank's API needs a commercial agreement with the bank or
// an aggregator, so none is bundled; the interface is here for when a tenant brings one. Only the mock exists.
import type { StatementLine } from './bank-parse.js';

export interface BankAdapter {
  readonly name: string;
  /** The statement lines for an account between two dates. */
  statement(accountRef: string, from: string, to: string): Promise<StatementLine[]>;
}

/** Gives back what it was given: for tests and demonstrations. */
export class MockBankAdapter implements BankAdapter {
  readonly name = 'mock';
  constructor(private readonly lines: StatementLine[] = []) {}
  statement(_accountRef: string, from: string, to: string) {
    return Promise.resolve(this.lines.filter((l) => l.date >= from && l.date <= to));
  }
}
