import type { Role } from "./types.js";

export class BudgetExhaustedError extends Error {
  override name = "BudgetExhaustedError";
}

/** Counts agent runs and refuses to start one past the cap. */
export class RunBudget {
  private used = 0;

  constructor(private readonly maxRuns: number) {}

  get runsUsed(): number {
    return this.used;
  }

  get runsLeft(): number {
    return this.maxRuns - this.used;
  }

  /** Reserve one run slot; throws instead of exceeding the cap. */
  take(role: Role): void {
    if (this.used >= this.maxRuns) {
      throw new BudgetExhaustedError(`run cap of ${this.maxRuns} reached before ${role} run`);
    }
    this.used += 1;
  }
}
