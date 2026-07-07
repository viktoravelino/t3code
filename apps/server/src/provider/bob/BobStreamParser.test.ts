import { describe, expect, it } from "vite-plus/test";

import { pairBobToolEvents, parseBobStreamLine, parseBobStreamText } from "./BobStreamParser.ts";

const PLAIN_FIXTURE = [
  `{"type":"init","timestamp":"2026-06-23T18:56:30.478Z","session_id":"1fd74ee7-b50e-4bf4-a073-b214b731949f","model":"premium"}`,
  `{"type":"message","timestamp":"2026-06-23T18:56:30.478Z","role":"user","content":"Reply exactly: T3_BOB_FIXTURE_OK"}`,
  `{"type":"message","timestamp":"2026-06-23T18:56:33.855Z","role":"assistant","content":"T","delta":true}`,
  `{"type":"tool_use","timestamp":"2026-06-23T18:56:36.669Z","tool_name":"attempt_completion","tool_id":"tool-1","parameters":{"result":"\\nT3_BOB_FIXTURE_OK\\n"}}`,
  `{"type":"tool_result","timestamp":"2026-06-23T18:56:36.671Z","tool_id":"tool-1","status":"success","output":"\\nT3_BOB_FIXTURE_OK\\n"}`,
  `{"type":"result","timestamp":"2026-06-23T18:56:36.671Z","status":"success","stats":{"total_tokens":60433,"input_tokens":60387,"output_tokens":46,"duration_ms":6193,"session_costs":0.151082,"max_budget":250,"budget_spend":0.2,"tool_calls":1}}`,
].join("\n");

const COMMAND_FIXTURE = [
  `{"type":"tool_use","timestamp":"2026-06-23T18:58:37.830Z","tool_name":"execute_command","tool_id":"tool-1","parameters":{"command":"pwd","timeout":5,"background":false}}`,
  `{"type":"tool_result","timestamp":"2026-06-23T18:58:37.879Z","tool_id":"tool-1","status":"success","output":"/Users/viktoravelino/projects/t3code"}`,
].join("\n");

describe("BOB stream parser", () => {
  it("parses captured NDJSON events", () => {
    const events = parseBobStreamText(PLAIN_FIXTURE);
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({
      type: "known",
      event: {
        type: "init",
        session_id: "1fd74ee7-b50e-4bf4-a073-b214b731949f",
        model: "premium",
      },
    });
  });

  it("pairs tool_use and tool_result by tool id", () => {
    const pairs = pairBobToolEvents(parseBobStreamText(COMMAND_FIXTURE));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.use.tool_name).toBe("execute_command");
    expect(pairs[0]?.result?.output).toBe("/Users/viktoravelino/projects/t3code");
  });

  it("turns malformed JSON into warnings", () => {
    expect(parseBobStreamLine("{not json")).toMatchObject({
      type: "warning",
    });
  });

  it("preserves unknown JSON events", () => {
    expect(parseBobStreamLine(`{"type":"new_event","value":1}`)).toEqual({
      type: "unknown",
      eventType: "new_event",
      payload: { type: "new_event", value: 1 },
    });
  });
});
