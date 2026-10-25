/**
 * Prompts may only name tools this server actually serves. A prompt that
 * points the model at data no tool returns (patch-gaps did, before the
 * patches domain existed) gets invented answers back.
 *
 * The general check only catches a prompt that names a missing tool. A prompt
 * that asks for data without naming any tool (the original patch-gaps text)
 * passes it, so patch-gaps has its own test below.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Server } from "@modelcontextprotocol/server";
import { registerPromptHandlers } from "../prompts.js";
import { getAvailableDomains, getDomainHandler } from "../domains/index.js";

type Handler = (request: { params: Record<string, unknown> }) => Promise<unknown>;

interface PromptList {
  prompts: Array<{ name: string }>;
}

interface PromptResult {
  messages: Array<{ content: { text: string } }>;
}

function promptHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const stub = {
    setRequestHandler: (method: string, handler: Handler) => handlers.set(method, handler),
  };
  registerPromptHandlers(stub as unknown as Server);
  return handlers;
}

async function servedToolNames(): Promise<Set<string>> {
  const names = new Set(["ninjaone_navigate", "ninjaone_status"]);
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    for (const tool of handler.getTools()) names.add(tool.name);
  }
  return names;
}

async function renderAll(): Promise<Map<string, string>> {
  const handlers = promptHandlers();
  const list = (await handlers.get("prompts/list")!({ params: {} })) as PromptList;
  const rendered = new Map<string, string>();
  for (const { name } of list.prompts) {
    for (const args of [undefined, { org_name: "Acme Corp" }]) {
      const result = (await handlers.get("prompts/get")!({
        params: { name, arguments: args },
      })) as PromptResult;
      const text = result.messages.map((m) => m.content.text).join("\n");
      rendered.set(`${name}${args ? " (org)" : ""}`, text);
    }
  }
  return rendered;
}

describe("prompts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("name only tools this server serves", async () => {
    const tools = await servedToolNames();
    const rendered = await renderAll();

    // A trailing * (ninjaone_patches_*) must match at least one served tool.
    const served = (name: string) =>
      name.endsWith("*")
        ? [...tools].some((tool) => tool.startsWith(name.slice(0, -1)))
        : tools.has(name);

    expect(rendered.size).toBeGreaterThan(0);
    for (const [prompt, text] of rendered) {
      const unknown = (text.match(/ninjaone_[a-z_]+\*?/g) ?? []).filter((t) => !served(t));
      expect(unknown, `prompt ${prompt}`).toEqual([]);
    }
  });

  it("ground patch-gaps in the patch report tools", async () => {
    const rendered = await renderAll();
    const text = rendered.get("patch-gaps")!;

    expect(text).toContain("ninjaone_patches_os_list");
    expect(text).toContain("ninjaone_patches_os_installs_list");
    expect(text).toContain("ninjaone_patches_software_list");
    expect(text).toContain("do not\nestimate counts");
    expect(rendered.get("patch-gaps (org)")).toContain("in Acme Corp");
  });

  it("make patch-gaps page every report before counting or calling a device stale", async () => {
    const text = (await renderAll()).get("patch-gaps")!.replace(/\s+/g, " ");

    expect(text).toContain(
      "Paging applies to every step: for each ninjaone_patches_* call without device_id, and for " +
        "ninjaone_organizations_devices and ninjaone_devices_list, keep calling with the returned " +
        "cursor while hasMore is true. Do not count missing patches (step 2) or failures (steps 3 " +
        "and 4), or conclude a device has no row (step 6), until hasMore is false."
    );
  });

  it("give patch-gaps the 30-day window as a date from the server clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T13:05:00Z"));

    const text = (await renderAll()).get("patch-gaps")!.replace(/\s+/g, " ");

    expect(text).toContain("status INSTALLED and installed_after 2026-09-22 (30 days ago)");
  });
});
