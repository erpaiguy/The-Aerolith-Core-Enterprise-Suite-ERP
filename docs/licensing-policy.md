# Licensing and Third-Party Policy (cross-cutting, applies to all phases)

**Rule:** no paid tools, and nothing in the codebase, bundle or installer that restricts commercial use.
Introduced in Phase 4 discussion; Phases 2, 3 and the stack were revised to comply.

## 1. Definitions

- **Embedded dependency**: anything compiled into, bundled with, or required to run the app we distribute (libraries, fonts, icons, database, cache, models, data files).
- **Operating service**: something we rent to run the business (hosting, domain, outbound email delivery, payment gateway fees, code-signing certificates). These cost money but are not embedded; every one sits behind an adapter so it can be swapped for a free or self-hosted alternative.

## 2. Licence allow-list for embedded dependencies

| Class | Licences | Rule |
|-------|----------|------|
| Allowed | MIT, BSD-2/3, ISC, Apache-2.0, PostgreSQL, Zlib, 0BSD, CC0, Unlicense, OFL (fonts), CC-BY (with attribution) | Use freely, keep notices |
| Allowed with care | MPL-2.0 (file-level copyleft), LGPL | Only unmodified, dynamically linked or as a separate process. Review each case. |
| Build tooling only | WTFPL | Permits all use including commercial; allowed for development/build tools that never ship (currently one transitive dependency of electron-builder) |
| **Banned** | GPL, AGPL, SSPL, BUSL, FSL, Elastic License, Commons Clause, RSAL, "source-available", non-commercial (CC-NC), proprietary freeware, "free for individuals/small companies", "free community edition with paid features" | Cannot be embedded or bundled |

AGPL/GPL tools may run **only as internal ops tooling** that is never distributed to tenants and never linked into our code. The self-hosted tenant bundle contains allowed licences only.

## 3. Enforcement

1. CI licence scan on every build (fails on unknown or banned licences), including transitive dependencies.
2. Generated SBOM (CycloneDX) and a bundled `THIRD_PARTY_NOTICES` file in every installer and image.
3. Dependency additions require a one-line entry in `docs/dependencies.md` (name, licence, why).
4. Pin versions. Re-check the licence on every major upgrade, because projects change licences (Redis, Elastic, MinIO, HashiCorp, Sentry all did).

## 4. Non-code assets (often overlooked)

| Asset | Policy |
|-------|--------|
| Rate libraries, schedules of rates (e.g. government SORs/DSRs), item descriptions | **Do not bundle** third-party price books or copy their text without written permission. Ship tenant-importable templates and our own originally written sample data. |
| Measurement standards (e.g. IS codes), specification text | Standards are copyrighted. Encode rules as our own paraphrase, cite the code number, do not copy text. |
| Fonts and icons | OFL fonts, ISC/MIT icon sets only |
| Third-party names (Tally, Primavera/P6, MS Project, Razorpay, GST portal) | Nominative references only. No logos, no implied endorsement. |
| File formats (XER, MPP, Tally XML) | Implement from public documentation and interoperability behaviour. See Phase 4 §P for per-format notes. |
| AI models (v2) | Only permissively licensed weights (e.g. Apache-2.0/MIT). Llama-style custom licences carry commercial restrictions and are excluded. Training data must be our own or tenant-consented. |

## 5. Replacements made when this policy was introduced

| Was | Problem | Now |
|-----|---------|-----|
| Redis | Licence changed away from BSD (source-available, later AGPL option) | **Valkey** (BSD-3) |
| MinIO | AGPL, and community edition feature-stripped | **SeaweedFS** (Apache-2.0) as default object store, behind an S3 adapter |
| Cloudflare R2 | Paid service | S3 adapter. Self-hosted default; a tenant may point to any S3-compatible store they already own |
| Sentry | FSL (not open source) | **GlitchTip** (MIT) |
| Grafana / Loki | AGPL | Internal ops only, never bundled. Tenant bundle uses Prometheus + OpenTelemetry (Apache-2.0) |
| Tauri (earlier option) | n/a | Electron is MIT, unaffected |
| AG Grid Enterprise (considered) | Paid | Never adopted. Glide Data Grid (MIT) + our own canvas code |

## 6. Costs this policy cannot remove (state them, don't hide them)

[Certain] A free app still needs money to *distribute and operate*. These are operating services, not embedded tools:

- Hosting and bandwidth, domain, outbound email delivery at volume.
- **Code-signing certificates** (Windows) and an Apple developer account (macOS notarisation). Unsigned installers trigger OS warnings that will hurt trial conversion.
- Payment gateway per-transaction fees.
- Aadhaar eSign (Wave 5) is a paid per-signature government-licensed service. The free path is PAdES signatures with the signer's own certificate. See Phase 4 §F.
- WhatsApp/SMS messaging is paid per message. v1 notifies by in-app and email only.
- Live bank APIs need commercial agreements with banks. See Phase 4 §D and 03 §14.
