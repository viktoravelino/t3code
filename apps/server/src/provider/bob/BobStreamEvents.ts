import * as Schema from "effect/Schema";

const BobBaseEvent = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.String),
});

export const BobInitEvent = Schema.Struct({
  ...BobBaseEvent.fields,
  type: Schema.Literal("init"),
  session_id: Schema.String,
  model: Schema.optional(Schema.String),
});
export type BobInitEvent = typeof BobInitEvent.Type;

export const BobMessageEvent = Schema.Struct({
  ...BobBaseEvent.fields,
  type: Schema.Literal("message"),
  role: Schema.Literals(["user", "assistant", "system"]),
  content: Schema.String,
  delta: Schema.optional(Schema.Boolean),
});
export type BobMessageEvent = typeof BobMessageEvent.Type;

export const BobToolUseEvent = Schema.Struct({
  ...BobBaseEvent.fields,
  type: Schema.Literal("tool_use"),
  tool_name: Schema.String,
  tool_id: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
});
export type BobToolUseEvent = typeof BobToolUseEvent.Type;

export const BobToolResultEvent = Schema.Struct({
  ...BobBaseEvent.fields,
  type: Schema.Literal("tool_result"),
  tool_id: Schema.String,
  status: Schema.String,
  output: Schema.optional(Schema.String),
});
export type BobToolResultEvent = typeof BobToolResultEvent.Type;

export const BobResultEvent = Schema.Struct({
  ...BobBaseEvent.fields,
  type: Schema.Literal("result"),
  status: Schema.String,
  stats: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BobResultEvent = typeof BobResultEvent.Type;

export const BobKnownEvent = Schema.Union([
  BobInitEvent,
  BobMessageEvent,
  BobToolUseEvent,
  BobToolResultEvent,
  BobResultEvent,
]);
export type BobKnownEvent = typeof BobKnownEvent.Type;

export type BobUnknownEvent = {
  readonly type: "unknown";
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
};

export type BobParsedEvent =
  | { readonly type: "known"; readonly event: BobKnownEvent }
  | BobUnknownEvent
  | { readonly type: "warning"; readonly line: string; readonly message: string };

export const isBobInitEvent = Schema.is(BobInitEvent);
export const isBobMessageEvent = Schema.is(BobMessageEvent);
export const isBobToolUseEvent = Schema.is(BobToolUseEvent);
export const isBobToolResultEvent = Schema.is(BobToolResultEvent);
export const isBobResultEvent = Schema.is(BobResultEvent);
