const ALLOWED_ROLES = new Set([
  "manager",
  "cashier",
  "kitchen",
  "inventory",
]);

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return send(res, 500, { error: "Staff invitations are not configured on the server." });
  }

  const authorization = req.headers.authorization || "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!accessToken) return send(res, 401, { error: "Sign in is required." });

  const { display_name, email, role } = req.body || {};
  if (
    typeof display_name !== "string" || !display_name.trim() || display_name.trim().length > 120 ||
    typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !ALLOWED_ROLES.has(role)
  ) {
    return send(res, 400, { error: "Enter a valid staff name, email, and non-admin role." });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  try {
    const authResponse = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!authResponse.ok) return send(res, 401, { error: "Your session is invalid or expired." });
    const caller = await authResponse.json();

    const profileResponse = await fetch(
      `${baseUrl}/rest/v1/staff_profiles?select=business_id,branch_id,role,active&user_id=eq.${encodeURIComponent(caller.id)}`,
      { headers }
    );
    if (!profileResponse.ok) return send(res, 500, { error: "Could not verify staff permissions." });
    const profiles = await profileResponse.json();
    const profile = profiles[0];
    if (!profile || profile.role !== "owner_admin" || !profile.active) {
      return send(res, 403, { error: "Only an active Owner/Admin can invite staff." });
    }

    const inviteUrl = new URL(`${baseUrl}/auth/v1/invite`);
    if (process.env.APP_URL) inviteUrl.searchParams.set("redirect_to", process.env.APP_URL);
    const inviteResponse = await fetch(inviteUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        data: { display_name: display_name.trim() },
      }),
    });
    const inviteResult = await inviteResponse.json().catch(() => ({}));
    if (!inviteResponse.ok || !inviteResult.id) {
      return send(res, inviteResponse.status || 502, {
        error: inviteResult.msg || inviteResult.message || "Could not send the staff invitation.",
      });
    }

    const profileResponseAfterInvite = await fetch(`${baseUrl}/rest/v1/staff_profiles`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: inviteResult.id,
        business_id: profile.business_id,
        branch_id: profile.branch_id,
        display_name: display_name.trim(),
        role,
      }),
    });
    if (!profileResponseAfterInvite.ok) {
      const cleanupResponse = await fetch(`${baseUrl}/auth/v1/admin/users/${inviteResult.id}`, {
        method: "DELETE",
        headers,
      });
      if (!cleanupResponse.ok) {
        return send(res, 502, {
          error: "The invitation was sent, but staff access could not be configured. Remove the pending user in Supabase Auth and try again.",
        });
      }
      return send(res, 500, { error: "Could not save the staff role. The invitation was cancelled; try again." });
    }
    return send(res, 201, { ok: true });
  } catch (error) {
    console.error("Staff invitation failed:", error);
    return send(res, 500, { error: "Unexpected server error while inviting staff." });
  }
};
