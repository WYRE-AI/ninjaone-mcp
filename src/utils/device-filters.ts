/**
 * Shared device-list filtering and pagination.
 *
 * GET /v2/organization/{id}/devices documents only `pageSize` and `after`
 * (NinjaRMM-API-v2 getOrganizationDevices). A named `nodeClass` query
 * parameter is not part of that operation, and GET /v2/devices ignores
 * named class parameters too — only `df=class=<NodeClass>` is applied.
 * Org-scoped calls therefore send that same `df` expression (the SDK copies
 * every list param onto the query string) and still filter the returned
 * page, because an undocumented `df` can be ignored.
 *
 * Neither endpoint returns a total or a next-page token. A page the same size
 * as `pageSize` is the signal that more devices exist; the cursor is the max
 * device id in that raw page (the API's `after` parameter). Compute the cursor
 * before client-side filtering so a page that filters down to a few matches
 * is not mistaken for the last page.
 */

/**
 * Node classes from the NinjaOne public API device schema
 * (GET /v2/devices and GET /v2/organization/{id}/devices).
 *
 * Shorthand values that are not node classes: `LINUX`, `VMWARE_VM`, `NMS`.
 * Network devices use the `NMS_*` classes.
 */
export const DEVICE_NODE_CLASSES = [
  "WINDOWS_SERVER",
  "WINDOWS_WORKSTATION",
  "LINUX_WORKSTATION",
  "MAC",
  "ANDROID",
  "APPLE_IOS",
  "APPLE_IPADOS",
  "VMWARE_VM_HOST",
  "VMWARE_VM_GUEST",
  "HYPERV_VMM_HOST",
  "HYPERV_VMM_GUEST",
  "LINUX_SERVER",
  "MAC_SERVER",
  "CLOUD_MONITOR_TARGET",
  "NMS_SWITCH",
  "NMS_ROUTER",
  "NMS_FIREWALL",
  "NMS_PRIVATE_NETWORK_GATEWAY",
  "NMS_PRINTER",
  "NMS_SCANNER",
  "NMS_DIAL_MANAGER",
  "NMS_WAP",
  "NMS_IPSLA",
  "NMS_COMPUTER",
  "NMS_VM_HOST",
  "NMS_APPLIANCE",
  "NMS_OTHER",
  "NMS_SERVER",
  "NMS_PHONE",
  "NMS_VIRTUAL_MACHINE",
  "NMS_NETWORK_MANAGEMENT_AGENT",
  "UNMANAGED_DEVICE",
  "MANAGED_DEVICE",
] as const;

export type DeviceNodeClassName = (typeof DEVICE_NODE_CLASSES)[number];

export interface FilterableDevice {
  id: number;
  nodeClass?: string;
  status?: string;
  offline?: boolean;
}

/**
 * Client-side device filter for endpoints that cannot apply class/online
 * themselves.
 *
 * Online-ness is read from the raw NinjaOne device (`offline` boolean),
 * falling back to the SDK's `status` field. When it can't be determined, the
 * device is treated as a match so an unexpected field shape degrades to
 * "unfiltered" rather than silently dropping every device.
 */
export function deviceMatchesFilters(
  device: FilterableDevice,
  deviceClass: string | undefined,
  online: boolean | undefined
): boolean {
  if (deviceClass !== undefined && device.nodeClass !== deviceClass) {
    return false;
  }
  if (online !== undefined) {
    const isOnline =
      typeof device.offline === "boolean"
        ? !device.offline
        : device.status === "ONLINE"
          ? true
          : device.status === "OFFLINE"
            ? false
            : undefined;
    if (isOnline !== undefined && isOnline !== online) {
      return false;
    }
  }
  return true;
}

/**
 * Query for GET /v2/organization/{id}/devices.
 *
 * `df` uses the same grammar as GET /v2/devices (`class=<NodeClass>`,
 * `online` / `offline`). `listByOrganization` forwards these keys as the
 * query string; a named `nodeClass` parameter would not.
 */
export interface OrganizationDevicesQuery {
  pageSize: number;
  after?: number;
  df?: string;
}

export function organizationDevicesQuery(options: {
  pageSize: number;
  after?: number;
  deviceClass?: string;
  online?: boolean;
}): OrganizationDevicesQuery {
  const query: OrganizationDevicesQuery = {
    pageSize: options.pageSize,
    after: options.after,
  };
  const df: string[] = [];
  if (options.deviceClass) df.push(`class=${options.deviceClass}`);
  if (options.online === true) df.push("online");
  else if (options.online === false) df.push("offline");
  if (df.length > 0) query.df = df.join(" AND ");
  return query;
}

/** `after` cursor for GET /v2/organization/{id}/devices. Non-numeric cursors are ignored. */
export function deviceIdAfter(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const after = Number(cursor);
  return Number.isFinite(after) ? after : undefined;
}

/**
 * Pagination metadata for a device page. `hasMore` and `cursor` describe the
 * raw API page; `devices`/`count` are what remains after client-side filters.
 */
export function devicePageResult<T extends FilterableDevice>(
  rawDevices: T[],
  limit: number,
  predicate: (device: T) => boolean
): { devices: T[]; count: number; hasMore: boolean; cursor?: string } {
  const hasMore = rawDevices.length === limit;
  const cursor = hasMore
    ? String(Math.max(...rawDevices.map((device) => device.id)))
    : undefined;
  const devices = rawDevices.filter(predicate);
  return { devices, count: devices.length, hasMore, cursor };
}
