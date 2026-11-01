import { describe, expect, it } from "vitest";
import { POND_PROTOCOL, REPLAY_HOST } from "./constants";

describe("REPLAY_HOST", () => {
  it("is an origin CSP accepts, so replayed pages may frame archived iframes", () => {
    /** wabac lists the replay origin in each replayed page's frame-src; CSP host names allow only letters, digits, hyphens and dots. */
    expect(`${POND_PROTOCOL}://${REPLAY_HOST}`).toMatch(
      /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*$/,
    );
  });
});
