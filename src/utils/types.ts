/**
 * Shared types for the NinjaOne MCP server
 */
import type { Tool } from "@modelcontextprotocol/server";

/**
 * Tool call result type - inline definition for MCP SDK compatibility
 */
export type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Domain handler interface
 */
export interface DomainHandler {
  /** Get the tools for this domain */
  getTools(): Tool[];
  /** Handle a tool call */
  handleCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>;
}

/**
 * Domain names for NinjaOne
 */
export type DomainName =
  | "devices"
  | "organizations"
  | "alerts"
  | "tickets";

/**
 * Check if a string is a valid domain name
 */
export function isDomainName(value: string): value is DomainName {
  return ["devices", "organizations", "alerts", "tickets"].includes(value);
}

/**
 * NinjaOne region type
 */
export type NinjaOneRegion = "us" | "eu" | "oc" | "ca" | "us2" | "fed";

/**
 * Check if a string is a valid NinjaOne region
 */
export function isValidRegion(value: string): value is NinjaOneRegion {
  return ["us", "eu", "oc", "ca", "us2", "fed"].includes(value);
}

/**
 * Get the base URL for a NinjaOne region
 */
export function getBaseUrlForRegion(region: NinjaOneRegion): string {
  switch (region) {
    case "eu":
      return "https://eu.ninjarmm.com";
    case "oc":
      return "https://oc.ninjarmm.com";
    case "ca":
      return "https://ca.ninjarmm.com";
    case "us2":
      return "https://us2.ninjarmm.com";
    case "fed":
      return "https://fed.ninjarmm.com";
    case "us":
    default:
      return "https://app.ninjarmm.com";
  }
}
