// POST /functions/v1/m365-tenant-info
// Headers: Authorization: Bearer <user JWT>
//
// Returns the data the "Add M365 user" wizard needs to populate its form:
//   • verified_domains:   [{ name, isDefault }]
//   • subscribed_skus:    [{ sku_id, sku_part_number, consumed, enabled, available, display_name }]
//
// We compute `available` as enabled - consumed; if negative we clamp to 0.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphJson } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Friendly names for Microsoft SKUs so the UI shows readable product names
// instead of cryptic skuPartNumbers like "EXCHANGEENTERPRISE" or "FLOW_FREE".
// Sourced from Microsoft's public "Product names and service plan identifiers
// for licensing" reference (learn.microsoft.com/entra/identity/users/
// licensing-service-plan-reference). Covers Microsoft 365, Office 365, EMS,
// Windows, Teams, Copilot, Power Platform, Defender, Intune, Viva, Dynamics,
// and Business Voice / Phone System — everything a tenant is likely to
// surface. Anything not in this map falls back to the skuPartNumber itself.
const SKU_FRIENDLY: Record<string, string> = {
  // --- Microsoft 365 Business
  "O365_BUSINESS_ESSENTIALS":         "Microsoft 365 Business Basic",
  "O365_BUSINESS_PREMIUM":            "Microsoft 365 Business Standard",
  "SPB":                              "Microsoft 365 Business Premium",
  "O365_BUSINESS":                    "Microsoft 365 Apps for Business",
  "SMB_BUSINESS":                     "Microsoft 365 Business Basic",
  "SMB_BUSINESS_ESSENTIALS":          "Microsoft 365 Business Basic",
  "SMB_BUSINESS_PREMIUM":             "Microsoft 365 Business Standard",
  "MICROSOFT_BUSINESS_CENTER":        "Microsoft Business Center",

  // --- Microsoft 365 Apps
  "OFFICESUBSCRIPTION":               "Microsoft 365 Apps for Enterprise",
  "OFFICESUBSCRIPTION_STUDENT":       "Microsoft 365 Apps for Students",
  "OFFICESUBSCRIPTION_FACULTY":       "Microsoft 365 Apps for Faculty",
  "OFFICE365_PROPLUS_TRIAL":          "Microsoft 365 Apps for Enterprise (Trial)",

  // --- Microsoft 365 Enterprise
  "ENTERPRISEPACK":                   "Microsoft 365 E3",
  "ENTERPRISEPREMIUM":                "Microsoft 365 E5",
  "ENTERPRISEPACKPLUS":               "Microsoft 365 E3 (with add-ons)",
  "ENTERPRISEPREMIUM_NOPSTNCONF":     "Microsoft 365 E5 without Audio Conferencing",
  "SPE_E3":                           "Microsoft 365 E3",
  "SPE_E5":                           "Microsoft 365 E5",
  "SPE_E3_USGOV_DOD":                 "Microsoft 365 E3 (US Government DOD)",
  "SPE_E3_USGOV_GCCHIGH":             "Microsoft 365 E3 (US Government GCC High)",
  "SPE_F1":                           "Microsoft 365 F1",
  "SPE_F3":                           "Microsoft 365 F3",
  "M365_F1":                          "Microsoft 365 F1",
  "M365_F1_COMM":                     "Microsoft 365 F1",
  "STANDARDPACK":                     "Office 365 E1",
  "STANDARDWOFFPACK":                 "Office 365 E2",
  "ENTERPRISEWITHSCAL":               "Office 365 E4",
  "DESKLESSPACK":                     "Office 365 F3",

  // --- Microsoft 365 Education
  "M365EDU_A1":                       "Microsoft 365 A1",
  "M365EDU_A3_FACULTY":               "Microsoft 365 A3 for Faculty",
  "M365EDU_A3_STUDENT":               "Microsoft 365 A3 for Students",
  "M365EDU_A3_STUUSEBNFT":            "Microsoft 365 A3 for Students Use Benefit",
  "M365EDU_A5_FACULTY":               "Microsoft 365 A5 for Faculty",
  "M365EDU_A5_STUDENT":               "Microsoft 365 A5 for Students",
  "M365EDU_A5_STUUSEBNFT":            "Microsoft 365 A5 for Students Use Benefit",
  "ENTERPRISEPACK_FACULTY":           "Office 365 A3 for Faculty",
  "ENTERPRISEPACK_STUDENT":           "Office 365 A3 for Students",
  "ENTERPRISEPREMIUM_FACULTY":        "Office 365 A5 for Faculty",
  "ENTERPRISEPREMIUM_STUDENT":        "Office 365 A5 for Students",
  "STANDARDWOFFPACK_FACULTY":         "Office 365 A1 for Faculty",
  "STANDARDWOFFPACK_STUDENT":         "Office 365 A1 for Students",

  // --- Exchange Online
  "EXCHANGESTANDARD":                 "Exchange Online (Plan 1)",
  "EXCHANGEENTERPRISE":               "Exchange Online (Plan 2)",
  "EXCHANGEDESKLESS":                 "Exchange Online Kiosk",
  "EXCHANGEARCHIVE":                  "Exchange Online Archiving",
  "EXCHANGEARCHIVE_ADDON":            "Exchange Online Archiving for Exchange Online",
  "EXCHANGE_S_ESSENTIALS":            "Exchange Online Essentials",
  "EOP_ENTERPRISE":                   "Exchange Online Protection",
  "EXCHANGETELCO":                    "Exchange Online POP",

  // --- SharePoint / OneDrive
  "SHAREPOINTSTANDARD":               "SharePoint Online (Plan 1)",
  "SHAREPOINTENTERPRISE":             "SharePoint Online (Plan 2)",
  "SHAREPOINT_PROJECT":               "SharePoint Project",
  "WACONEDRIVESTANDARD":              "OneDrive for Business (Plan 1)",
  "WACONEDRIVEENTERPRISE":            "OneDrive for Business (Plan 2)",

  // --- Teams
  "MCOSTANDARD":                      "Skype for Business Online (Plan 2)",
  "TEAMS_EXPLORATORY":                "Microsoft Teams Exploratory",
  "TEAMS_COMMERCIAL_TRIAL":           "Microsoft Teams Commercial Cloud Trial",
  "TEAMS_FREE":                       "Microsoft Teams (Free)",
  "MCOEV":                            "Microsoft Teams Phone Standard",
  "MCOEV_VIRTUALUSER":                "Microsoft Teams Phone Resource Account",
  "MCOMEETADV":                       "Microsoft 365 Audio Conferencing",
  "MEETING_ROOM":                     "Microsoft Teams Rooms Standard",
  "Teams_Room_Standard":              "Microsoft Teams Rooms Standard",
  "Teams_Room_Pro":                   "Microsoft Teams Rooms Pro",
  "Microsoft_Teams_Rooms_Basic":      "Microsoft Teams Rooms Basic",
  "Microsoft_Teams_Rooms_Pro":        "Microsoft Teams Rooms Pro",
  "MCOPSTN1":                         "Microsoft Teams Domestic Calling Plan",
  "MCOPSTN2":                         "Microsoft Teams Domestic and International Calling Plan",
  "MCOPSTN5":                         "Microsoft Teams Domestic Calling Plan (120 min)",
  "MCOPSTNC":                         "Communications Credits",
  "PHONESYSTEM_VIRTUALUSER":          "Microsoft Teams Phone Resource Account",
  "Teams_Ess":                        "Microsoft Teams Essentials",

  // --- Power Platform
  "FLOW_FREE":                        "Microsoft Power Automate Free",
  "FLOW_P1":                          "Power Automate (Plan 1)",
  "FLOW_P2":                          "Power Automate (Plan 2)",
  "FLOW_PER_USER":                    "Power Automate per user plan",
  "FLOW_PER_USER_DEPT":               "Power Automate per user plan for Departments",
  "FLOW_PER_FLOW":                    "Power Automate per flow plan",
  "POWERAUTOMATE_ATTENDED_RPA":       "Power Automate per user with attended RPA plan",
  "POWERAUTOMATE_UNATTENDED_RPA":     "Power Automate unattended RPA add-on",
  "POWER_BI_STANDARD":                "Power BI (free)",
  "POWER_BI_PRO":                     "Power BI Pro",
  "POWER_BI_PRO_CE":                  "Power BI Pro CE",
  "PBI_PREMIUM_PER_USER":             "Power BI Premium (per user)",
  "PBI_PREMIUM_PER_USER_ADDON":       "Power BI Premium per user add-on",
  "PBI_PREMIUM_P1_ADDON":             "Power BI Premium P1 add-on",
  "POWERAPPS_VIRAL":                  "Microsoft Power Apps Plan 2 Trial",
  "POWERAPPS_PER_USER":               "Power Apps per user plan",
  "POWERAPPS_PER_APP":                "Power Apps per app plan",
  "POWERAPPS_DEV":                    "Microsoft Power Apps for Developer",
  "POWERAPPS_P1":                     "Microsoft Power Apps Plan 1",
  "POWERAPPS_P2":                     "Microsoft Power Apps Plan 2",
  "CCIBOTS_PRIVPREV_VIRAL":           "Power Virtual Agents Viral Trial",
  "DYN365_BUSCENTRAL_TEAM_MEMBER":    "Dynamics 365 Business Central Team Member",
  "DYN365_ENTERPRISE_SALES":          "Dynamics 365 Sales Enterprise",
  "DYN365_ENTERPRISE_CUSTOMER_SERVICE": "Dynamics 365 Customer Service Enterprise",

  // --- Enterprise Mobility + Security
  "EMS":                              "Enterprise Mobility + Security E3",
  "EMSPREMIUM":                       "Enterprise Mobility + Security E5",
  "AAD_BASIC":                        "Azure Active Directory Basic",
  "AAD_PREMIUM":                      "Microsoft Entra ID P1",
  "AAD_PREMIUM_P2":                   "Microsoft Entra ID P2",
  "RMS_S_ENTERPRISE":                 "Azure Rights Management",
  "RMS_S_PREMIUM":                    "Azure Information Protection Plan 1",
  "RMS_S_PREMIUM2":                   "Azure Information Protection Plan 2",
  "INTUNE_A":                         "Microsoft Intune Plan 1",
  "INTUNE_A_D":                       "Microsoft Intune Device",
  "INTUNE_SMB":                       "Microsoft Intune SMB",
  "INTUNE_A_VL":                      "Microsoft Intune (Volume License)",
  "INTUNE_STORAGE":                   "Intune Extra Storage",

  // --- Defender / Security
  "ATP_ENTERPRISE":                   "Microsoft Defender for Office 365 (Plan 1)",
  "THREAT_INTELLIGENCE":              "Microsoft Defender for Office 365 (Plan 2)",
  "IDENTITY_THREAT_PROTECTION":       "Microsoft 365 E5 Security",
  "IDENTITY_THREAT_PROTECTION_FOR_EMS_E5": "Microsoft 365 E5 Security for EMS E5",
  "INFORMATION_PROTECTION_COMPLIANCE": "Microsoft 365 E5 Compliance",
  "M365_SECURITY_COMPLIANCE_FOR_FLW": "Microsoft 365 Security and Compliance for Firstline Workers",
  "WIN_DEF_ATP":                      "Microsoft Defender for Endpoint",
  "MDATP_XPLAT":                      "Microsoft Defender for Endpoint (Server)",
  "Defender_for_IoT":                 "Microsoft Defender for IoT",

  // --- Copilot
  "Microsoft_365_Copilot":            "Microsoft 365 Copilot",
  "COPILOT_STUDIO":                   "Microsoft Copilot Studio",
  "M365_COPILOT_TEAMS":               "Microsoft 365 Copilot for Teams",

  // --- Windows
  "WIN10_PRO_ENT_SUB":                "Windows 10/11 Enterprise E3",
  "WIN10_VDA_E3":                     "Windows 10/11 Enterprise E3",
  "WIN10_VDA_E5":                     "Windows 10/11 Enterprise E5",
  "WINDOWS_STORE":                    "Windows Store for Business",
  "WIN_ENT_E5":                       "Windows 10/11 Enterprise E5",

  // --- Viva / Yammer
  "VIVA":                             "Microsoft Viva Suite",
  "TOPIC_EXPERIENCES":                "Microsoft Viva Topics",
  "VIVA_GOALS":                       "Microsoft Viva Goals",
  "VIVA_LEARNING_SEEDED":             "Viva Learning Seeded",
  "YAMMER_ENTERPRISE":                "Yammer Enterprise",
  "YAMMER_MIDSIZE":                   "Yammer Midsize",

  // --- Project & Visio
  "PROJECTESSENTIALS":                "Project Online Essentials",
  "PROJECTONLINE_PLAN_1":             "Project Online (Plan 1)",
  "PROJECTONLINE_PLAN_2":             "Project Online (Plan 2)",
  "PROJECTPROFESSIONAL":              "Project Plan 3",
  "PROJECTPREMIUM":                   "Project Plan 5",
  "PROJECT_P1":                       "Project Plan 1",
  "PROJECT_MADEIRA_PREVIEW_IW_SKU":   "Dynamics 365 Business Central for IWs",
  "VISIOONLINE_PLAN1":                "Visio Plan 1",
  "VISIOCLIENT":                      "Visio Plan 2",

  // --- Add-ons / Misc
  "STREAM":                           "Microsoft Stream",
  "STREAM_P2":                        "Microsoft Stream Plan 2",
  "STREAM_STORAGE":                   "Microsoft Stream Storage Add-On",
  "SWAY":                             "Sway",
  "FORMS_PLAN_E5":                    "Microsoft Forms (Plan E5)",
  "FORMS_PRO":                        "Microsoft Forms Pro",
  "SCHOOL_DATA_SYNC_P2":              "School Data Sync (Plan 2)",
  "MEE_FACULTY":                      "Minecraft Education Edition Faculty",
  "MEE_STUDENT":                      "Minecraft Education Edition Student",
  "MICROSOFT_REMOTE_ASSIST":          "Dynamics 365 Remote Assist",
  "CLIPCHAMP_STANDARD":               "Clipchamp Standard",
  "CLIPCHAMP":                        "Microsoft Clipchamp",
  "BUSINESS_VOICE_MED2":              "Microsoft 365 Business Voice",
  "BUSINESS_VOICE_MED2_TELCO":        "Microsoft 365 Business Voice (with Calling Plan)",
  "MCOCAP":                           "Common Area Phone",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return json({ error: "no org for caller" }, 403);

  try {
    const [domainsResp, skusResp] = await Promise.all([
      // Graph returns domain rows where the domain string lives in `id`
      // (not `name`). Map it to `name` so the rest of the code reads cleanly.
      graphJson<{ value: Array<{ id: string; isDefault: boolean; isVerified: boolean }> }>(orgId, {
        path: "/domains?$select=id,isDefault,isVerified",
      }),
      graphJson<{ value: Array<{ skuId: string; skuPartNumber: string; consumedUnits: number; prepaidUnits: { enabled: number } }> }>(orgId, {
        path: "/subscribedSkus",
      }),
    ]);

    const verified_domains = (domainsResp.value ?? [])
      .filter((d) => d.isVerified && d.id)
      .map((d) => ({ name: d.id, isDefault: !!d.isDefault }))
      .sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : (a.isDefault ? -1 : 1)));

    const subscribed_skus = (skusResp.value ?? []).map((s) => {
      const enabled = s.prepaidUnits?.enabled ?? 0;
      const consumed = s.consumedUnits ?? 0;
      const available = Math.max(0, enabled - consumed);
      return {
        sku_id: s.skuId,
        sku_part_number: s.skuPartNumber,
        consumed, enabled, available,
        display_name: SKU_FRIENDLY[s.skuPartNumber] ?? s.skuPartNumber,
      };
    }).sort((a, b) => a.display_name.localeCompare(b.display_name));

    return json({ verified_domains, subscribed_skus }, 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
