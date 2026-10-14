/**
 * Elicitation helpers for MCP tool handlers.
 *
 * Selection and free-text helpers return null when the client cannot answer.
 * Confirmation is different: a decline, a cancellation, and a transport error
 * must not be reported as "unsupported", or a caller can fall through to a
 * weaker confirmation path after a human already refused.
 */
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/server";
import { getServerRef } from "./server-ref.js";

export interface ElicitOption {
  value: string;
  label: string;
}

/**
 * Ask the user to select from a list of options.
 */
export async function elicitSelection(
  message: string,
  fieldName: string,
  options: ElicitOption[]
): Promise<string | null> {
  const server = getServerRef();
  if (!server) return null;

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          [fieldName]: {
            type: "string" as const,
            title: fieldName,
            description: `Select a ${fieldName}`,
            enum: options.map((o) => o.value),
            enumNames: options.map((o) => o.label),
          },
        },
        required: [fieldName],
      },
    });

    if (result.action === "accept" && result.content) {
      return result.content[fieldName] as string;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask the user for a free-text input.
 */
export async function elicitText(
  message: string,
  fieldName: string,
  description?: string
): Promise<string | null> {
  const server = getServerRef();
  if (!server) return null;

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          [fieldName]: {
            type: "string" as const,
            title: fieldName,
            description: description ?? `Enter ${fieldName}`,
          },
        },
        required: [fieldName],
      },
    });

    if (result.action === "accept" && result.content) {
      return result.content[fieldName] as string;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Outcome of a confirmation prompt.
 *
 * - `accepted` — the client implemented elicitation and the user submitted
 *   the form. `confirm` is the checkbox value; `false` is a refusal.
 * - `declined` — the user declined or cancelled, or accepted without a
 *   boolean `confirm`. This is a refusal, not a missing capability.
 * - `unsupported` — this client cannot be asked. `elicitInput` throws
 *   `CapabilityNotSupported` when the client did not advertise form
 *   elicitation, and `MethodNotSupportedByProtocolVersion` on the
 *   2026-07-28 era where the push-style request does not exist.
 * - `error` — the prompt failed for any other reason (timeout, validation,
 *   no server bound). Fail closed: do not treat this as unsupported.
 */
export type ConfirmationOutcome =
  | { status: "accepted"; confirm: boolean }
  | { status: "declined" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

function isUnsupportedElicitation(error: unknown): boolean {
  return (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.CapabilityNotSupported ||
      error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion)
  );
}

/**
 * Ask the user to confirm an action.
 */
export async function elicitConfirmation(message: string): Promise<ConfirmationOutcome> {
  const server = getServerRef();
  if (!server) {
    return { status: "error", message: "No MCP server is bound to this request." };
  }

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          confirm: {
            type: "boolean" as const,
            title: "Confirm",
            description: "Confirm this action",
          },
        },
        required: ["confirm"],
      },
    });

    if (result.action === "accept" && result.content && typeof result.content.confirm === "boolean") {
      return { status: "accepted", confirm: result.content.confirm };
    }
    // decline, cancel, or an accept that did not carry a boolean confirm.
    return { status: "declined" };
  } catch (error) {
    if (isUnsupportedElicitation(error)) {
      return { status: "unsupported" };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
