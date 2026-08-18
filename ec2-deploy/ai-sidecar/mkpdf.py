import zlib, sys
lines = [
  "Adobe Systems Software Ireland Limited",
  "4-6 Riverwalk, Citywest Business Campus",
  "adobe.com", "",
  "INVOICE", "",
  "Invoice Number: INV-2026-0042",
  "Issue Date: 2026-06-10",
  "Due Date: 2026-07-10", "",
  "Bill to: Rudrans Pvt Ltd", "",
  "Service: Creative Cloud All Apps",
  "Period: 2026-06-10 to 2026-07-10", "",
  "Subtotal: USD 54.99",
  "Tax: USD 0.00",
  "Total Due: USD 54.99", "",
  "Status: Paid",
]
ops = ["BT /F1 11 Tf"] + [f"1 0 0 1 50 {750-i*16} Tm ({ln}) Tj" for i, ln in enumerate(lines)] + ["ET"]
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
