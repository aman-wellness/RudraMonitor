# Azure Trusted Signing — Setup Guide

**Goal**: Eliminate "Windows protected your PC" / "Unknown publisher" SmartScreen warnings + pass corporate MDM (Intune, Jamf for Windows) install checks. Signed binaries are also trusted by every major antivirus (no false-positive blocks).

This is a one-time setup that costs **~$10/month** and takes **~2–3 business days** to complete (mostly identity verification).

---

## What is Azure Trusted Signing?

A Microsoft-hosted code-signing service. Unlike old-school EV certs that ship a USB hardware token to your office, Azure holds the private key in their HSM. Your CI just calls the Azure API to sign, no token shuffling. Same SmartScreen trust as a traditional EV cert at ~1/30th the cost.

---

## Steps

### 1. Azure subscription + Trusted Signing account

1. Sign in to Azure Portal → search **Trusted Signing Accounts** → **Create**.
2. Pick a resource group (or create one).
3. **Region**: pick whichever Azure region is closest (e.g. `eastus`, `centralindia`).
4. **Pricing tier**: choose **Basic** ($9.99 /month). Sufficient for <5,000 signatures/month.
5. Create.

### 2. Identity verification

This is the long part. Trusted Signing requires identity validation to issue certs in your company name.

1. In your new Trusted Signing account → **Identity Validation** → **New identity validation**.
2. Submit:
   - **Legal company name**: `Rudrans Pvt. Ltd.` (must match GST / incorporation docs)
   - **Country**: India
   - **Address**: registered office address
   - **Authorized signer**: your name + work email + phone
3. Upload company-incorporation proof (GST cert / Certificate of Incorporation).
4. Microsoft verifies via a third-party (DigiCert). Typical SLA: **1–3 business days**. They may email you for clarifications.
5. Once approved, status flips to **Completed**.

### 3. Create a Certificate Profile

After identity validation:

1. Trusted Signing account → **Certificate profiles** → **Create**.
2. **Type**: **Public Trust** (for shipping to customers; SmartScreen + everywhere).
3. **Identity validation**: pick the one you just verified.
4. **Profile name**: e.g. `wellness-extract-prod`.
5. Create.

### 4. Service principal for GitHub Actions

1. Azure Portal → **App registrations** → **New registration**:
   - Name: `github-trusted-signing`
   - Single-tenant
2. After creation, note:
   - **Application (client) ID** → goes into GH secret `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`
3. Generate a client secret: **Certificates & secrets** → **New client secret** (24 months) → copy → `AZURE_CLIENT_SECRET`
4. Grant the app permission to sign with your Cert Profile:
   - Trusted Signing account → **Access control (IAM)** → **Add role assignment**
   - Role: **Trusted Signing Certificate Profile Signer**
   - Member: search for `github-trusted-signing`
   - Save.

### 5. Add GitHub secrets

In `https://github.com/<org>/<repo>/settings/secrets/actions` add:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | from step 4 |
| `AZURE_CLIENT_ID` | from step 4 |
| `AZURE_CLIENT_SECRET` | from step 4 |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net/` (or your region's endpoint — see Trusted Signing account → Overview) |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | the account name from step 1 |
| `AZURE_TRUSTED_SIGNING_PROFILE` | the cert profile name from step 3 |

### 6. Wire Tauri to sign with Azure

Edit `agent/src-tauri/tauri.conf.json` → `bundle.windows`:

```jsonc
"windows": {
  "allowDowngrades": true,
  "signCommand": "trusted-signing-cli sign -e %AZURE_TRUSTED_SIGNING_ENDPOINT% -a %AZURE_TRUSTED_SIGNING_ACCOUNT% -c %AZURE_TRUSTED_SIGNING_PROFILE% -d \"Rudrans Agent\" -ru https://wellnessextract.com \"%1\"",
  "nsis": { ... },
  "wix": { ... }
}
```

### 7. Update CI to install + auth `trusted-signing-cli`

In `.github/workflows/build-agent.yml`, before the Windows build step add:

```yaml
- name: Install trusted-signing-cli (Windows only)
  if: matrix.os == 'windows-latest'
  shell: pwsh
  run: |
    cargo install trusted-signing-cli
- name: Azure login (Windows only)
  if: matrix.os == 'windows-latest'
  uses: azure/login@v2
  with:
    creds: ${{ secrets.AZURE_CREDENTIALS_JSON }}   # combined JSON of tenant/client/secret
```

(Or use the individual env vars — `trusted-signing-cli` reads `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` from env if set.)

### 8. Verify

After the next `v*` tag pushes, download the signed EXE and right-click → **Properties** → **Digital Signatures** tab. You should see:
- Name: `Rudrans Pvt. Ltd.`
- Signing time + cert chain rooted at `Microsoft ID Verified CS EOC CA 01`

SmartScreen will stop warning. Most antivirus engines will whitelist the binary on submission of the new hash.

---

## In the meantime (before Azure approves you)

**One free 24-hour fix**: submit the unsigned EXE to Microsoft Defender for analysis at <https://www.microsoft.com/en-us/wdsi/filesubmission/>. Pick "Software developer" → fill the form → upload the .exe. Microsoft typically whitelists the specific SHA-256 hash within 24 hours. Doesn't fix the underlying problem (next release re-triggers it), but unblocks today's installs.

**For Aman Saini's MDM**: the IT admin can manually allowlist the EXE by **file hash** in Intune / AppLocker. They need:
- App name: `Security Assistant`
- File hash: SHA-256 of the EXE (visible in Windows: `Get-FileHash <path>`)
- Source: your download URL.

The MSI bundle (added in v0.6.1) is also much easier for MDMs to deploy via Intune's Win32 app uploader.
