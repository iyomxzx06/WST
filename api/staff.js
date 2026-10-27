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
  const appUrl = process.env.APP_URL;
  if (!supabaseUrl || !serviceRoleKey || !appUrl) {
    return send(res, 500, { error: "Staff invitations are not configured on the server." });
  }
  try {
    new URL(appUrl);
  } catch {
    return send(res, 500, { error: "The staff invitation redirect URL is invalid. Check APP_URL in Vercel." });
  }

  const authorization = req.headers.authorization || "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!accessToken) return send(res, 401, { error: "Sign in is required." });

  const { action, display_name, email, role, user_id } = req.body || {};
  const isResend = action === "resend";
  if (isResend && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user_id || "")) {
    return send(res, 400, { error: "Select a valid staff account." });
  }
  if (!isResend && (
    typeof display_name !== "string" || !display_name.trim() || display_name.trim().length > 120 ||
    typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !ALLOWED_ROLES.has(role))) {
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

    if (isResend) {
      const staffResponse = await fetch(
        `${baseUrl}/rest/v1/staff_profiles?select=user_id,role&user_id=eq.${encodeURIComponent(user_id)}&business_id=eq.${encodeURIComponent(profile.business_id)}`,
        { headers }
      );
      if (!staffResponse.ok) return send(res, 500, { error: "Could not verify the staff account." });
      const staffRows = await staffResponse.json();
      const staff = staffRows[0];
      if (!staff || staff.role === "owner_admin") {
        return send(res, 404, { error: "That staff account was not found in your business." });
      }

      const userResponse = await fetch(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(user_id)}`, { headers });
      if (!userResponse.ok) return send(res, 500, { error: "Could not verify the staff email in Supabase Auth." });
      const userResult = await userResponse.json();
      const invitedUser = userResult.user || userResult;
      if (!invitedUser?.email) return send(res, 404, { error: "The staff Auth account could not be found." });
      if (invitedUser.email_confirmed_at) {
        return send(res, 409, { error: "This account has already accepted an invitation. Ask the staff member to use Forgot password on the login screen." });
      }

      const resendUrl = new URL(`${baseUrl}/auth/v1/resend`);
      resendUrl.searchParams.set("redirect_to", appUrl);
      const resendResponse = await fetch(resendUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "signup", email: invitedUser.email }),
      });
      const resendResult = await resendResponse.json().catch(() => ({}));
      if (!resendResponse.ok) {
        return send(res, resendResponse.status || 502, {
          error: resendResult.msg || resendResult.message || "Could not resend the staff setup email.",
        });
      }
      return send(res, 200, { ok: true, email: invitedUser.email });
    }

    const inviteUrl = new URL(`${baseUrl}/auth/v1/invite`);
    inviteUrl.searchParams.set("redirect_to", appUrl);
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
