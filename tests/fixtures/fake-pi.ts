export interface CapturedEmission {
  event: string;
  data: unknown;
}

export class FakeEventBus {
  readonly emissions: CapturedEmission[] = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => unknown>>();

  on(event: string, handler: (data: unknown) => unknown): () => void {
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

  async emitAsync(event: string, data: unknown): Promise<unknown[]> {
    this.emissions.push({ event, data });
    const results: unknown[] = [];
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      results.push(await handler(data));
    }
    return results;
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

export interface FakeCommand {
  description: string;
  handler(args: string, ctx: FakePiContext): Promise<void> | void;
}

export interface FakeNotification {
  message: string;
  level?: string;
}

export interface FakeMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
}

export interface FakePiContext {
  mode: 'tui' | 'rpc' | 'json' | 'print';
  hasUI: boolean;
  cwd: string;
  ui: {
    notify(message: string, level?: string): void;
    setStatus(key: string, value: string | undefined): void;
    custom(...args: unknown[]): Promise<unknown>;
    input(...args: unknown[]): Promise<undefined>;
    select(...args: unknown[]): Promise<undefined>;
  };
  scopedModels: unknown[];
  model: undefined;
  modelRegistry: { getAvailable(): unknown[] };
}

export class FakePi {
  readonly events = new FakeEventBus();
  readonly commands = new Map<string, FakeCommand>();
  readonly handlers = new Map<string, Set<(event: any, ctx: FakePiContext) => unknown>>();
  readonly userMessages: Array<{ content: unknown; options?: unknown }> = [];
  readonly messages: Array<{ message: FakeMessage; options?: unknown }> = [];
  readonly statuses: Array<{ key: string; value: string | undefined }> = [];
  readonly notifications: FakeNotification[] = [];
  readonly availableModels: unknown[] = [];

  readonly context: FakePiContext;

  constructor(mode: FakePiContext['mode'] = 'tui', cwd = '/repo') {
    this.context = {
      mode,
      hasUI: mode === 'tui' || mode === 'rpc',
      cwd,
      ui: {
        notify: (message, level) => this.notifications.push({ message, level }),
        setStatus: (key, value) => this.statuses.push({ key, value }),
        custom: async () => undefined,
        input: async () => undefined,
        select: async () => undefined,
      },
      scopedModels: [],
      model: undefined,
      modelRegistry: { getAvailable: () => this.availableModels },
    };
  }

  registerCommand(name: string, command: FakeCommand): void {
    this.commands.set(name, command);
  }

  on(event: string, handler: (event: any, ctx: FakePiContext) => unknown): void {
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
  }

  sendUserMessage(content: unknown, options?: unknown): void {
    this.userMessages.push({ content, options });
  }

  sendMessage(message: FakeMessage, options?: unknown): void {
    this.messages.push({ message, options });
  }

  async command(name: string, args = '', context = this.context): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Command not registered: ${name}`);
    await command.handler(args, context);
  }

  async emit(event: string, data: unknown, context = this.context): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      results.push(await handler(data, context));
    }
    return results;
  }

  /** Simulate Pi's input transform pipeline and expose the prompt reaching agent start. */
  async inputToAgentStart(text: string, source = 'interactive'): Promise<{
    inputResult: unknown;
    prompt?: string;
  }> {
    let current = text;
    let lastResult: unknown = { action: 'continue' };
    for (const handler of [...(this.handlers.get('input') ?? [])]) {
      const result = await handler({ type: 'input', text: current, source }, this.context) as any;
      lastResult = result ?? { action: 'continue' };
      if (result?.action === 'handled') return { inputResult: result };
      if (result?.action === 'transform') current = result.text;
    }
    await this.emit('before_agent_start', { type: 'before_agent_start', prompt: current, systemPrompt: '' });
    return { inputResult: lastResult, prompt: current };
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
