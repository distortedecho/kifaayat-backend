// ============================================================
// Admin roles & permissions (Phase 0.2)
//
// Granular permissions mapped to roles. The permission matrix mirrors
// ADMIN_PHASE0_SPEC.md §0.2. `permissions_override` on an admin_users row
// can grant/deny individual permissions on top of the role default.
// ============================================================

export type AdminRole = "owner" | "admin" | "moderator" | "support";

export const ADMIN_PERMISSIONS = [
  "listings.review", // approve / reject / edit / status
  "listings.delete",
  "transactions.refund",
  "transactions.force_advance",
  "payouts.release", // mark-sent / mark-failed / retry
  "moderation.act", // publish / redact / warn / suspend / review hide
  "users.ban",
  "users.mask", // impersonate
  "users.delete", // permanent — owner only
  "taxonomy.edit",
  "settings.edit",
  "content.edit",
  "export.run",
  "export.pii",
  "team.manage", // invite / role — owner only
  "audit.read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const ALL: AdminPermission[] = [...ADMIN_PERMISSIONS];

// Role → default permission set (see spec §0.2 matrix).
export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  owner: ALL,
  admin: [
    "listings.review",
    "listings.delete",
    "transactions.refund",
    "transactions.force_advance",
    "payouts.release",
    "moderation.act",
    "users.ban",
    "users.mask",
    "taxonomy.edit",
    "settings.edit",
    "content.edit",
    "export.run",
    "audit.read",
  ],
  moderator: ["moderation.act", "users.ban", "audit.read"],
  support: ["audit.read"],
};

/**
 * Does this role (+ optional per-user override) grant `permission`?
 * Override shape: { grant?: string[], deny?: string[] }. deny wins.
 */
export function hasPermission(
  role: AdminRole | null | undefined,
  permission: AdminPermission,
  override?: { grant?: string[]; deny?: string[] } | null
): boolean {
  if (override?.deny?.includes(permission)) return false;
  if (override?.grant?.includes(permission)) return true;
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
