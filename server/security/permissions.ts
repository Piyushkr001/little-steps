import type { AdminPermission, AdminRole } from "../../lib/admin/types";

/**
 * Explicit allowlist of all recognized administrative permissions.
 * Wildcard ("*") grants are never treated as an unchecked pass-through;
 * even SUPER_ADMIN is bound to this explicit privilege definition.
 */
export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  "dashboard:read",
  "users:read",
  "users:manage",
  "providers:read",
  "providers:verify",
  "centers:manage",
  "bookings:read",
  "bookings:manage",
  "incidents:read",
  "incidents:manage",
  "reports:read",
  "audit:read",
  "settings:manage",
] as const;

export const SUPER_ADMIN_EXPLICIT_PERMISSIONS: ReadonlySet<AdminPermission> =
  new Set<AdminPermission>(ALL_ADMIN_PERMISSIONS);

export const ADMIN_ALLOWED_PERMISSIONS: ReadonlySet<AdminPermission> =
  new Set<AdminPermission>([
    "dashboard:read",
    "users:read",
    "users:manage",
    "providers:read",
    "providers:verify",
    "centers:manage",
    "bookings:read",
    "bookings:manage",
    "incidents:read",
    "incidents:manage",
    "reports:read",
    "audit:read",
    "settings:manage",
  ]);

export const DEFAULT_STANDARD_ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  "dashboard:read",
  "users:read",
  "users:manage",
  "providers:read",
  "providers:verify",
  "centers:manage",
  "bookings:read",
  "bookings:manage",
  "incidents:read",
  "incidents:manage",
  "reports:read",
  "audit:read",
];

const IMPLIED_READ_PERMISSIONS: Partial<
  Record<AdminPermission, AdminPermission[]>
> = {
  "users:manage": ["users:read"],
  "providers:verify": ["providers:read"],
  "centers:manage": ["providers:read"],
  "bookings:manage": ["bookings:read"],
  "incidents:manage": ["incidents:read"],
};

function isKnownPermission(value: string): value is AdminPermission {
  return (ALL_ADMIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Resolves the effective, normalized list of permissions for an administrator
 * based on their `AdminRole` and `admin_profiles.permissions` array.
 *
 * Security Rules:
 * 1. Unknown/unrecognized permission strings are rejected.
 * 2. Every permission is intersected with the role's explicit ceiling
 *    (`SUPER_ADMIN_EXPLICIT_PERMISSIONS` or `ADMIN_ALLOWED_PERMISSIONS`).
 * 3. Domain mutation permissions (`users:manage`, `providers:verify`,
 *    `bookings:manage`, `incidents:manage`) imply the corresponding `:read`
 *    permission for that domain.
 * 4. Legacy pre-Phase-1 full operational profiles (containing all 5 core
 *    domain manage permissions + `audit:read`) automatically receive
 *    `dashboard:read` and `reports:read` so existing seeded accounts remain
 *    compatible without weakening granular least-privilege profiles.
 */
export function resolveEffectiveAdminPermissions(
  role: AdminRole,
  rawPermissions: readonly string[] | null | undefined
): AdminPermission[] {
  const roleCeiling =
    role === "SUPER_ADMIN"
      ? SUPER_ADMIN_EXPLICIT_PERMISSIONS
      : ADMIN_ALLOWED_PERMISSIONS;

  const inputList = Array.isArray(rawPermissions) ? rawPermissions : [];
  const effective = new Set<AdminPermission>();

  for (const item of inputList) {
    if (!isKnownPermission(item)) continue;
    if (!roleCeiling.has(item)) continue;

    effective.add(item);
    const implied = IMPLIED_READ_PERMISSIONS[item];
    if (implied) {
      for (const imp of implied) {
        if (roleCeiling.has(imp)) {
          effective.add(imp);
        }
      }
    }
  }

  // Backward-compatibility for existing profiles created before `dashboard:read` and `reports:read`
  // were separated into standalone permission keys:
  const hasFullLegacyOperationalSet =
    effective.has("users:manage") &&
    effective.has("providers:verify") &&
    effective.has("centers:manage") &&
    effective.has("bookings:manage") &&
    effective.has("incidents:manage") &&
    effective.has("audit:read");

  if (hasFullLegacyOperationalSet) {
    effective.add("dashboard:read");
    effective.add("reports:read");
  }

  return Array.from(effective);
}

/**
 * Checks whether an authenticated administrator holds a specific permission.
 */
export function hasAdminPermission(
  admin: { role: AdminRole; permissions: readonly string[] },
  requiredPermission: AdminPermission
): boolean {
  const roleCeiling =
    admin.role === "SUPER_ADMIN"
      ? SUPER_ADMIN_EXPLICIT_PERMISSIONS
      : ADMIN_ALLOWED_PERMISSIONS;

  if (!roleCeiling.has(requiredPermission)) {
    return false;
  }

  const effective = resolveEffectiveAdminPermissions(
    admin.role,
    admin.permissions
  );
  return effective.includes(requiredPermission);
}
