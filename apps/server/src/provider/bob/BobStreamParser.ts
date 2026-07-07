import * as Schema from "effect/Schema";

import {
  BobKnownEvent,
  type BobParsedEvent,
  type BobToolResultEvent,
  type BobToolUseEvent,
  isBobToolResultEvent,
  isBobToolUseEvent,
} from "./BobStreamEvents.ts";

const isKnownEvent = Schema.is(BobKnownEvent);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBobStreamLine(line: string): BobParsedEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return {
      type: "warning",
      line,
      message: cause instanceof Error ? cause.message : "Failed to parse BOB stream line.",
    };
  }

  if (!isRecord(parsed)) {
    return {
      type: "warning",
      line,
      message: "BOB stream line decoded to a non-object payload.",
    };
  }

  if (isKnownEvent(parsed)) {
    return { type: "known", event: parsed };
  }

  const eventType = typeof parsed.type === "string" ? parsed.type : "unknown";
  return {
    type: "unknown",
    eventType,
    payload: parsed,
  };
}

export function parseBobStreamText(text: string): ReadonlyArray<BobParsedEvent> {
  const parsed: BobParsedEvent[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const event = parseBobStreamLine(line);
    if (event) parsed.push(event);
  }
  return parsed;
}

export interface BobToolPair {
  readonly use: BobToolUseEvent;
  readonly result?: BobToolResultEvent | undefined;
}

export function pairBobToolEvents(
  events: ReadonlyArray<BobParsedEvent>,
): ReadonlyArray<BobToolPair> {
  const pairs = new Map<string, BobToolPair>();
  for (const parsed of events) {
    if (parsed.type !== "known") continue;
    const event = parsed.event;
    if (isBobToolUseEvent(event)) {
      pairs.set(event.tool_id, { use: event, result: pairs.get(event.tool_id)?.result });
    } else if (isBobToolResultEvent(event)) {
      const existing = pairs.get(event.tool_id);
      if (existing) {
        pairs.set(event.tool_id, { ...existing, result: event });
      }
    }
  }
  return [...pairs.values()];
}
