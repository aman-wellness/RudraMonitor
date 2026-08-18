"""Build an invoice PDF that deliberately uses unconventional labels so
the regex-only extractor misses some fields and the LLM fallback kicks
in. Used to time the slow-path latency."""
import zlib, sys
lines = [
    "Quirky Subscription Co Pvt Ltd",
    "support@quirky.io",
    "",
    "Statement of Charges",
    "",
    "Reference: QSC/2026/JUN/0042",
    "Generated on the tenth of June, 2026",
    "",
    "Customer: Rudrans Pvt Ltd",
    "",
    "Plan: Quirky Premium Annual",
    "Coverage window: June 10 thru July 10, 2026",
    "",
    "Total Due: USD 54.99",
    "",
    "Settled in full.",
]
ops = ["BT /F1 11 Tf"] + [f"1 0 0 1 50 {750 - i * 16} Tm ({ln}) Tj" for i, ln in enumerate(lines)] + ["ET"]
content = "\n".join(ops).encode()
stream = zlib.compress(content)
objs = [
    b"<</Type /Catalog /Pages 2 0 R>>",
    b"<</Type /Pages /Kids [3 0 R] /Count 1>>",
    b"<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>",
    b"<</Length " + str(len(stream)).encode() + b" /Filter /FlateDecode>>\nstream\n" + stream + b"\nendstream",
    b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
]
parts = [b"%PDF-1.4\n"]
xr = []
for i, o in enumerate(objs, 1):
    xr.append(sum(len(p) for p in parts))
    parts.append(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
xo = sum(len(p) for p in parts)
parts.append(b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n")
for x in xr:
    parts.append(f"{x:010d} 00000 n \n".encode())
parts.append(f"trailer\n<</Size {len(objs) + 1} /Root 1 0 R>>\nstartxref\n{xo}\n%%EOF\n".encode())
with open(sys.argv[1], "wb") as f:
    f.write(b"".join(parts))
print(f"wrote {sys.argv[1]}")
