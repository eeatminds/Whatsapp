/**
 * Synchronous in-process event bus. Lets contacts, sequences and campaigns react to each other
 * (a tag being added enrolls a contact in a drip sequence; an opt-out stops everything) without the
 * services holding references to one another.
 */
export interface BusEvents {
  'tag.added': { contactId: number; tagId: number };
  'consent.changed': { contactId: number; from: string; to: string };
  'contact.replied': { contactId: number; at: string };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class Bus {
  private readonly handlers = new Map<keyof BusEvents, Array<Handler<keyof BusEvents>>>();

  on<K extends keyof BusEvents>(event: K, handler: Handler<K>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<keyof BusEvents>);
    this.handlers.set(event, list);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}
