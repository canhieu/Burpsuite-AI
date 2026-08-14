export class PauseGate {
  private paused = false
  private waiters: Array<() => void> = []

  get isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.release()
  }

  release(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  async wait(): Promise<void> {
    if (!this.paused) return
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}
