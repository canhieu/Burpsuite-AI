export interface BudgetWarning {
  metric: string
  value: number
  cap: number
}

export class BudgetTracker {
  private _requestsUsed = 0
  private _costUsd = 0
  private warned = new Set<string>()

  constructor(
    public readonly capRequests: number | undefined,
    public readonly deadline: number | undefined,
    public readonly capCostUsd: number | undefined,
    private onWarning?: (w: BudgetWarning) => void,
  ) {}

  get requestsUsed(): number {
    return this._requestsUsed
  }

  get costUsd(): number {
    return this._costUsd
  }

  private warn(metric: string, value: number, cap: number | undefined): void {
    if (cap === undefined || this.warned.has(metric)) return
    if (value >= cap * 0.8) {
      this.warned.add(metric)
      this.onWarning?.({ metric, value, cap })
    }
  }

  tryConsumeRequest(): { ok: boolean; reason?: string } {
    if (this.capRequests !== undefined && this._requestsUsed >= this.capRequests) {
      return { ok: false, reason: "request budget exhausted" }
    }
    this._requestsUsed++
    this.warn("requests", this._requestsUsed, this.capRequests)
    return { ok: true }
  }

  addCost(usd: number): void {
    if (usd <= 0) return
    this._costUsd += usd
    this.warn("costUsd", this._costUsd, this.capCostUsd)
  }

  checkDuration(): boolean {
    if (this.deadline === undefined) return true
    return Date.now() < this.deadline
  }

  exhaustedReason(): string | undefined {
    if (this.capRequests !== undefined && this._requestsUsed >= this.capRequests) {
      return "request budget exhausted"
    }
    if (this.deadline !== undefined && Date.now() >= this.deadline) {
      return "duration budget exhausted"
    }
    if (this.capCostUsd !== undefined && this._costUsd >= this.capCostUsd) {
      return "cost budget exhausted"
    }
    return undefined
  }
}

export class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  }

  private readonly limit: number

  get running(): number {
    return this.active
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active++
  }

  release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }
}
