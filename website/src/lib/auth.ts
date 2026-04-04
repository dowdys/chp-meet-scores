import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export type AdminRole = "admin" | "shipping" | "viewer";

/** Role hierarchy: admin > shipping > viewer */
const ROLE_LEVEL: Record<AdminRole, number> = {
  viewer: 0,
  shipping: 1,
  admin: 2,
};

type AuthSuccess = {
  user: { id: string; email: string };
  role: AdminRole;
  error: null;
};
type AuthError = { user: null; role: null; error: NextResponse };

/**
 * Verify the current request is from an authenticated admin user.
 * Returns the user and their role if valid, or a 401/403 NextResponse if not.
 * Use in API routes that require admin access.
 */
export async function requireAdmin(): Promise<AuthSuccess | AuthError> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // API routes don't need to set cookies
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      user: null,
      role: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  // Verify user is in admin_users table
  const { data: admin } = await supabase
    .from("admin_users")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (!admin) {
    return {
      user: null,
      role: null,
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return {
    user: { id: user.id, email: user.email || "" },
    role: (admin.role || "viewer") as AdminRole,
    error: null,
  };
}

/**
 * Require a minimum role level for access.
 * - `admin` can do everything
 * - `shipping` can view + create labels + mark batches
 * - `viewer` can only view (read-only)
 *
 * Throws an error if the user's role is insufficient.
 * Returns the user and their actual role on success.
 */
export async function requireRole(
  minRole: AdminRole
): Promise<{ user: { id: string; email: string }; role: AdminRole }> {
  const auth = await requireAdmin();
  if (auth.error) throw new Error("Unauthorized");

  const userLevel = ROLE_LEVEL[auth.role];
  const requiredLevel = ROLE_LEVEL[minRole];

  if (userLevel < requiredLevel) {
    throw new Error(
      `Forbidden: requires ${minRole} role, you have ${auth.role}`
    );
  }

  return { user: auth.user, role: auth.role };
}

/**
 * Get the current user's role without enforcing a minimum.
 * Returns the role string, or null if not authenticated.
 * Useful for conditional UI rendering in server components.
 */
export async function getUserRole(): Promise<AdminRole | null> {
  const auth = await requireAdmin();
  if (auth.error) return null;
  return auth.role;
}
