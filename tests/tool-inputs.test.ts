import { describe, expect, it } from "vitest";
import { checkAvailability } from "@/server/agent/tools/calendar";

describe("check_availability input", () => {
  it("caps an over-long search window instead of failing the call", () => {
    // Small local models often ask for 30 days; rejecting that only costs an extra round trip.
    expect(checkAvailability.input.parse({ days_ahead: 30, max_slots: 50 })).toEqual({
      days_ahead: 21,
      max_slots: 12,
    });
    expect(checkAvailability.input.parse({ days_ahead: "14" })).toMatchObject({ days_ahead: 14 });
    expect(checkAvailability.input.parse({})).toEqual({ days_ahead: 7, max_slots: 6 });
  });

  it("still rejects values below the minimum or non-integers", () => {
    expect(checkAvailability.input.safeParse({ days_ahead: 0 }).success).toBe(false);
    expect(checkAvailability.input.safeParse({ days_ahead: 2.5 }).success).toBe(false);
    expect(checkAvailability.input.safeParse({ days_ahead: "soon" }).success).toBe(false);
  });
});
