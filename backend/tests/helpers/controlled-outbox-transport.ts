
import type {
  OutboxEvent,
  OutboxTransport,
} from "../../src/services/outbox-publisher.service";

export class ControlledOutboxTransport implements OutboxTransport {
  available = true;

  readonly acceptedEvents: OutboxEvent[] = [];

  async publish(event: OutboxEvent): Promise<void> {
    if (!this.available) {
      throw new Error("Test messaging destination unavailable");
    }

    this.acceptedEvents.push(event);
  }
}
