import { describe, it, expect } from "vitest";
import { ControlledOutboxTransport } from "../helpers/controlled-outbox-transport";
import type { OutboxEvent } from "../../src/services/outbox-publisher.service";

const mockEvent = {
  id: "event-1",
} as OutboxEvent;

describe("ControlledOutboxTransport", () => {
  it("accepts and records events when the destination is available", async () => {
    const transport = new ControlledOutboxTransport();

    await transport.publish(mockEvent);

    expect(transport.acceptedEvents).toEqual([mockEvent]);
  });

  it("rejects publication when the destination is unavailable", async () => {
    const transport = new ControlledOutboxTransport();
    transport.available = false;

    await expect(transport.publish(mockEvent)).rejects.toThrow(
      "Test messaging destination unavailable",
    );

    expect(transport.acceptedEvents).toHaveLength(0);
  });

  it("records duplicate deliveries instead of silently deduplicating them", async () => {
    const transport = new ControlledOutboxTransport();

    await transport.publish(mockEvent);
    await transport.publish(mockEvent);

    expect(transport.acceptedEvents).toEqual([mockEvent, mockEvent]);
  });
});