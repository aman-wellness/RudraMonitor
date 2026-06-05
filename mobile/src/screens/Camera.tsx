// Camera screen — the app's home. One big shutter button. Tapping it
// opens the native camera UI via @capacitor/camera, captures a JPEG,
// stores the base64 in the App-root buffer, navigates to Preview.
//
// Source: CameraSource.Camera (not gallery — we want a fresh photo).
// quality: 80 + width: 1600 → typically 300-700 KB JPEGs, well under
// the invoice-extract 20 MB cap.

import { useNavigate } from "react-router-dom";
import { Camera as CapCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import type { CapturedImage } from "../App";
import { useRef, useState } from "react";
import OrgHeader from "../components/OrgHeader";

interface Props {
  onCaptured: (img: CapturedImage) => void;
}

export default function CameraScreen({ onCaptured }: Props) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hidden <input type="file"> for the "Upload PDF / file" path. Capacitor
  // camera plugin can't open Files (PDFs etc.), so we use the native
  // file picker which on iPhone surfaces Files + iCloud + Drive + Gmail,
  // and on Android surfaces Drive + Downloads + any storage app.
  const filePickerRef = useRef<HTMLInputElement | null>(null);

  const snap = async () => {
    setBusy(true);
    setError(null);
    try {
      const photo = await CapCamera.getPhoto({
        quality: 80,
        width: 1600,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
        saveToGallery: false,
        correctOrientation: true,
      });
      if (!photo.base64String) throw new Error("No image data returned");
      const mime = photo.format ? `image/${photo.format}` : "image/jpeg";
      onCaptured({
        base64: photo.base64String,
        mime,
        width: 1600,
        height: 1600,
      });
      navigate("/preview");
    } catch (e) {
      const msg = (e as Error).message;
      if (/cancel/i.test(msg)) return;            // user dismissed — silent
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  // PDF / any-file path. Opens native file picker. Limit accept attribute
  // to "PDF + any image" — covers receipts in any format the customer
  // might already have on their phone.
  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";              // reset so picking the same file twice still fires onChange
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) {
      setError(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max 20 MB.`);
      return;
    }
    setBusy(true);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      onCaptured({
        base64,
        mime: f.type || "application/octet-stream",
        width: 0,
        height: 0,
      });
      setBusy(false);
      navigate("/preview");
    };
    reader.onerror = () => {
      setError("Could not read file");
      setBusy(false);
    };
    reader.readAsDataURL(f);
  };

  const pickFromGallery = async () => {
    setBusy(true);
    setError(null);
    try {
      const photo = await CapCamera.getPhoto({
        quality: 80,
        width: 1600,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Photos,
        correctOrientation: true,
      });
      if (!photo.base64String) throw new Error("No image data returned");
      onCaptured({
        base64: photo.base64String,
        mime: photo.format ? `image/${photo.format}` : "image/jpeg",
        width: 1600,
        height: 1600,
      });
      navigate("/preview");
    } catch (e) {
      const msg = (e as Error).message;
      if (/cancel/i.test(msg)) return;
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      paddingTop: "env(safe-area-inset-top)",
      background: "#0f1115",
    }}>
      <OrgHeader />

      <div style={{ padding: "16px 20px 0" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Snap an invoice</h1>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "#9ba3af" }}>
          We'll read it with Claude, you confirm, then it lands in Rudrans.
        </p>
      </div>

      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", padding: 24,
      }}>
        <div style={{
          width: 220, height: 220, borderRadius: 32,
          border: "2px dashed #2a313c",
          background: "#13171e",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          marginBottom: 32,
        }}>
          <div style={{ fontSize: 64, lineHeight: 1, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 13, color: "#9ba3af", textAlign: "center", padding: "0 20px" }}>
            Place invoice flat,<br />good lighting, then tap below
          </div>
        </div>

        <button
          onClick={snap}
          disabled={busy}
          style={{
            width: 92, height: 92, borderRadius: 46,
            background: busy ? "#1a1f27" : "#22d3a2",
            border: "4px solid #0f1115",
            boxShadow: "0 0 0 4px #22d3a2",
            color: "#0f1115",
            fontSize: 14, fontWeight: 700,
            cursor: busy ? "wait" : "pointer",
          }}
          aria-label="Take photo"
        >
          {busy ? "…" : "SNAP"}
        </button>

        <div style={{ marginTop: 24, display: "flex", gap: 10 }}>
          <button
            onClick={pickFromGallery}
            disabled={busy}
            style={altBtn}
          >
            📷 Photos
          </button>
          <button
            onClick={() => filePickerRef.current?.click()}
            disabled={busy}
            style={altBtn}
          >
            📄 Upload PDF / file
          </button>
        </div>
        <input
          ref={filePickerRef}
          type="file"
          accept="application/pdf,image/*"
          onChange={pickFile}
          style={{ display: "none" }}
        />

        {error && (
          <div style={{
            marginTop: 16,
            padding: "10px 14px",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 8,
            fontSize: 12,
            color: "#fca5a5",
            maxWidth: 280,
            textAlign: "center",
          }}>{error}</div>
        )}
      </div>
    </div>
  );
}

const altBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: "transparent",
  color: "#9ba3af",
  border: "1px solid #2a313c",
  borderRadius: 999,
  fontSize: 12,
  cursor: "pointer",
};
