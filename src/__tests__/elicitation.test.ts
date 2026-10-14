/**
 * Confirmation outcomes must not collapse "the user said no" into
 * "this client cannot ask". scripts_run uses that distinction to decide
 * whether self-attested confirmation is even eligible.
 */
import { describe, it, expect, vi } from "vitest";
import { SdkError, SdkErrorCode, type Server } from "@modelcontextprotocol/server";
import { bindServerRef } from "../utils/server-ref.js";
import { elicitConfirmation, type ConfirmationOutcome } from "../utils/elicitation.js";

type Handler = () => unknown;

function withElicit(elicitInput: ReturnType<typeof vi.fn>): Promise<ConfirmationOutcome> {
  const handlers = new Map<string, Handler>();
  const server = {
    elicitInput,
    setRequestHandler(method: string, handler: Handler) {
      handlers.set(method, handler);
    },
    invoke(method: string) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`No handler registered for ${method}`);
      return Promise.resolve(handler());
    },
  };
  bindServerRef(server as unknown as Server);
  server.setRequestHandler("tools/call", () => elicitConfirmation("Run the script?"));
  return server.invoke("tools/call") as Promise<ConfirmationOutcome>;
}

describe("elicitConfirmation", () => {
  it("returns an error when no server is bound, rather than unsupported", async () => {
    await expect(elicitConfirmation("Run the script?")).resolves.toEqual({
      status: "error",
      message: "No MCP server is bound to this request.",
    });
  });

  it("returns accepted when the user submits confirm: true", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { confirm: true },
    });
    await expect(withElicit(elicitInput)).resolves.toEqual({
      status: "accepted",
      confirm: true,
    });
  });

  it("returns accepted with confirm false when the box is unchecked", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { confirm: false },
    });
    await expect(withElicit(elicitInput)).resolves.toEqual({
      status: "accepted",
      confirm: false,
    });
  });

  it.each(["decline", "cancel"] as const)(
    "returns declined when the user action is %s",
    async (action) => {
      const elicitInput = vi.fn().mockResolvedValue({ action });
      await expect(withElicit(elicitInput)).resolves.toEqual({ status: "declined" });
    }
  );

  it("returns declined when accept carries no boolean confirm", async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: "accept", content: {} });
    await expect(withElicit(elicitInput)).resolves.toEqual({ status: "declined" });
  });

  it("returns unsupported only for a missing elicitation capability", async () => {
    const elicitInput = vi.fn().mockRejectedValue(
      new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support form elicitation.")
    );
    await expect(withElicit(elicitInput)).resolves.toEqual({ status: "unsupported" });
  });

  it("returns unsupported when this protocol era has no push-style elicitation", async () => {
    const elicitInput = vi.fn().mockRejectedValue(
      new SdkError(
        SdkErrorCode.MethodNotSupportedByProtocolVersion,
        "elicitation/create cannot be sent on this protocol revision"
      )
    );
    await expect(withElicit(elicitInput)).resolves.toEqual({ status: "unsupported" });
  });

  it("returns error for any other elicitation failure", async () => {
    const elicitInput = vi.fn().mockRejectedValue(new Error("request timed out"));
    await expect(withElicit(elicitInput)).resolves.toEqual({
      status: "error",
      message: "request timed out",
    });
  });
});
