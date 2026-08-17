/**
 * Tests for shared types and utility functions
 */

import { describe, it, expect } from "vitest";
import {
  isDomainName,
  isValidRegion,
  getBaseUrlForRegion,
  parseScopes,
} from "../utils/types.js";

describe("Type Utilities", () => {
  describe("isDomainName", () => {
    it("should return true for valid domain names", () => {
      expect(isDomainName("devices")).toBe(true);
      expect(isDomainName("organizations")).toBe(true);
      expect(isDomainName("alerts")).toBe(true);
      expect(isDomainName("tickets")).toBe(true);
    });

    it("should return false for invalid domain names", () => {
      expect(isDomainName("invalid")).toBe(false);
      expect(isDomainName("")).toBe(false);
      expect(isDomainName("DEVICES")).toBe(false);
      expect(isDomainName("device")).toBe(false);
      expect(isDomainName("customers")).toBe(false);
    });
  });

  describe("isValidRegion", () => {
    it("should return true for valid regions", () => {
      expect(isValidRegion("us")).toBe(true);
      expect(isValidRegion("eu")).toBe(true);
      expect(isValidRegion("oc")).toBe(true);
      expect(isValidRegion("ca")).toBe(true);
      expect(isValidRegion("us2")).toBe(true);
      expect(isValidRegion("fed")).toBe(true);
    });

    it("should return false for invalid regions", () => {
      expect(isValidRegion("invalid")).toBe(false);
      expect(isValidRegion("")).toBe(false);
      expect(isValidRegion("US")).toBe(false);
      expect(isValidRegion("ap")).toBe(false);
    });
  });

  describe("getBaseUrlForRegion", () => {
    it("should return correct URL for US region", () => {
      expect(getBaseUrlForRegion("us")).toBe("https://app.ninjarmm.com");
    });

    it("should return correct URL for EU region", () => {
      expect(getBaseUrlForRegion("eu")).toBe("https://eu.ninjarmm.com");
    });

    it("should return correct URL for OC region", () => {
      expect(getBaseUrlForRegion("oc")).toBe("https://oc.ninjarmm.com");
    });

    it("should return correct URL for CA region", () => {
      expect(getBaseUrlForRegion("ca")).toBe("https://ca.ninjarmm.com");
    });

    it("should return correct URL for US2 region", () => {
      expect(getBaseUrlForRegion("us2")).toBe("https://us2.ninjarmm.com");
    });

    it("should return correct URL for FED region", () => {
      expect(getBaseUrlForRegion("fed")).toBe("https://fed.ninjarmm.com");
    });
  });

  describe("parseScopes", () => {
    it("returns undefined when unset, blank, or an unresolved config placeholder", () => {
      // undefined means "caller did not choose" — the SDK default applies.
      expect(parseScopes(undefined)).toBeUndefined();
      expect(parseScopes("")).toBeUndefined();
      expect(parseScopes("   ")).toBeUndefined();
      expect(parseScopes("${user_config.ninjaone_scopes}")).toBeUndefined();
    });

    it("parses a single scope — the monitoring-only case that used to 400", () => {
      expect(parseScopes("monitoring")).toEqual(["monitoring"]);
    });

    it("accepts comma- or space-separated lists", () => {
      expect(parseScopes("monitoring,management")).toEqual(["monitoring", "management"]);
      expect(parseScopes("monitoring management")).toEqual(["monitoring", "management"]);
      expect(parseScopes("monitoring, management control")).toEqual([
        "monitoring",
        "management",
        "control",
      ]);
    });

    it("is case- and whitespace-insensitive", () => {
      expect(parseScopes("  MONITORING , Control ")).toEqual(["monitoring", "control"]);
    });

    it("de-duplicates repeated scopes", () => {
      expect(parseScopes("monitoring,monitoring,management")).toEqual([
        "monitoring",
        "management",
      ]);
    });

    it("drops unrecognized scopes but keeps the valid ones", () => {
      expect(parseScopes("monitoring,bogus")).toEqual(["monitoring"]);
    });

    it("returns undefined when nothing valid remains, falling back to the default", () => {
      expect(parseScopes("bogus")).toBeUndefined();
      expect(parseScopes("bogus,nonsense")).toBeUndefined();
    });
  });
});
