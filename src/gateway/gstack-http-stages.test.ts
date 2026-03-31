import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, vi } from "vitest";

// Mock delegate-http to avoid deep import chain (→ auth-profiles → @mariozechner/pi-ai/oauth)
vi.mock("./delegate-http.js", () => ({
  handleDelegateHttpRequest: vi.fn().mockResolvedValue(false),
}));

import { buildGstackRequestStages, type GstackHttpStagesConfig } from "./gstack-http-stages.js";

function makeMockConfig(): GstackHttpStagesConfig {
  return {
    auth: { kind: "token", token: "test" } as unknown as GstackHttpStagesConfig["auth"],
    taskTracker: {} as unknown as GstackHttpStagesConfig["taskTracker"],
    eventRelay: {
      handleTicketRequest: vi.fn().mockReturnValue(false),
      handleSseRequest: vi.fn().mockResolvedValue(false),
    } as unknown as GstackHttpStagesConfig["eventRelay"],
    memory: undefined,
    workflowEngine: undefined,
  };
}

describe("buildGstackRequestStages", () => {
  const req = {} as IncomingMessage;
  const res = {} as ServerResponse;

  it("returns 3 stages with correct names", () => {
    const stages = buildGstackRequestStages(req, res, makeMockConfig());
    expect(stages).toHaveLength(3);
    expect(stages.map((s) => s.name)).toEqual([
      "gstack-delegate",
      "gstack-events-ticket",
      "gstack-events",
    ]);
  });

  it("all stages have a callable run function", () => {
    const stages = buildGstackRequestStages(req, res, makeMockConfig());
    for (const stage of stages) {
      expect(typeof stage.run).toBe("function");
    }
  });

  it("gstack-events-ticket stage delegates to eventRelay.handleTicketRequest", () => {
    const config = makeMockConfig();
    const stages = buildGstackRequestStages(req, res, config);
    const ticketStage = stages.find((s) => s.name === "gstack-events-ticket")!;

    void ticketStage.run();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(config.eventRelay.handleTicketRequest).toHaveBeenCalledWith(req, res);
  });

  it("gstack-events stage delegates to eventRelay.handleSseRequest", async () => {
    const config = makeMockConfig();
    const stages = buildGstackRequestStages(req, res, config);
    const eventsStage = stages.find((s) => s.name === "gstack-events")!;

    await eventsStage.run();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(config.eventRelay.handleSseRequest).toHaveBeenCalledWith(req, res);
  });

  it("gstack-delegate stage calls handleDelegateHttpRequest", async () => {
    const { handleDelegateHttpRequest } = await import("./delegate-http.js");
    const config = makeMockConfig();
    const stages = buildGstackRequestStages(req, res, config);
    const delegateStage = stages.find((s) => s.name === "gstack-delegate")!;

    await delegateStage.run();

    expect(handleDelegateHttpRequest).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        auth: config.auth,
        taskTracker: config.taskTracker,
        eventRelay: config.eventRelay,
      }),
    );
  });

  it("passes optional workflowEngine to delegate stage config", async () => {
    const { handleDelegateHttpRequest } = await import("./delegate-http.js");
    const engine = { start: vi.fn() } as unknown as GstackHttpStagesConfig["workflowEngine"];
    const config = { ...makeMockConfig(), workflowEngine: engine };
    const stages = buildGstackRequestStages(req, res, config);

    await stages[0].run();

    expect(handleDelegateHttpRequest).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        workflowEngine: engine,
      }),
    );
  });
});
