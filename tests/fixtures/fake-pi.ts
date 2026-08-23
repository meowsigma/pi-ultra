export interface CapturedEmission {
  event: string;
  data: unknown;
}

export class FakeEventBus {
  readonly emissions: CapturedEmission[] = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    let listeners = this.handlers.get(event);
    if (!listeners) {
      listeners = new Set();
      this.handlers.set(event, listeners);
    }
    listeners.add(handler);
    return () => {
      listeners?.delete(handler);
      if (listeners?.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, data: unknown): void {
    this.emissions.push({ event, data });
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  lastEmission(event: string): CapturedEmission | undefined {
    for (let index = this.emissions.length - 1; index >= 0; index -= 1) {
      const emission = this.emissions[index];
      if (emission?.event === event) return emission;
    }
    return undefined;
  }
}
