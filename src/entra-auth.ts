import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface EntraAuthConfig {
  tenantId: string;
  clientId: string;
  audience: string;
  requiredScope: string;
  issuer: string;
  protectedResource: string;
}

export interface EntraAuthResult {
  authenticated: boolean;
  status: number;
  error?: string;
  claims?: JWTPayload;
}

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`${name} is required when MCP_AUTH_MODE=entra`);
  }
  return value;
}

export function getEntraAuthConfig(): EntraAuthConfig {
  const tenantId = requiredEnv("ENTRA_TENANT_ID");
  const clientId = requiredEnv("ENTRA_CLIENT_ID");

  return {
    tenantId,
    clientId,
    audience:
      (process.env.ENTRA_AUDIENCE ?? "").trim() || `api://${clientId}`,
    requiredScope:
      (process.env.ENTRA_REQUIRED_SCOPE ?? "").trim() || "access_as_user",
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    protectedResource: requiredEnv("MCP_PROTECTED_RESOURCE").replace(/\/$/, ""),
  };
}

export function getProtectedResourceMetadata(config: EntraAuthConfig) {
  return {
    resource: config.protectedResource,
    authorization_servers: [
      `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
    ],
    scopes_supported: [config.requiredScope],
    bearer_methods_supported: ["header"],
  };
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function scopes(payload: JWTPayload): string[] {
  return typeof payload.scp === "string"
    ? payload.scp.split(/\s+/).filter(Boolean)
    : [];
}

export function createEntraTokenValidator(config: EntraAuthConfig) {
  const jwks = createRemoteJWKSet(
    new URL(
      `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`
    )
  );

  return async (authorization: string | undefined): Promise<EntraAuthResult> => {
    const token = bearerToken(authorization);

    if (!token) {
      return {
        authenticated: false,
        status: 401,
        error: "Missing Authorization bearer token",
      };
    }

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      });

      if (!scopes(payload).includes(config.requiredScope)) {
        return {
          authenticated: false,
          status: 403,
          error: `Token is missing required scope: ${config.requiredScope}`,
        };
      }

      return {
        authenticated: true,
        status: 200,
        claims: payload,
      };
    } catch {
      return {
        authenticated: false,
        status: 401,
        error: "Invalid or expired Microsoft Entra access token",
      };
    }
  };
}
