# Traffic Fine Lookup VN - OpenClaw Skill

This skill allows users to check traffic (fine) violations for Vietnamese vehicles (cars, motorbikes) by license plate using vnetraffic.org as an intermediary, with guidance to cross-verify on official portals.

---

## Script

```javascript
#!/usr/bin/env node

import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plate') out.plate = argv[++i];
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--phone') out.phone = argv[++i];
  }
  return out;
}

function normalizePlate(s = '') {
  return String(s).toUpperCase().replace(/[\-\.\s]/g, '');
}

function mapType(t = '') {
  const x = String(t).toLowerCase();
  if (x === 'oto') return 1;
  if (x === 'xemay') return 2;
  if (x === 'xemaydien') return 3;
  return null;
}

function usage() {
  console.error('Usage: node scripts/check_vnetraffic.mjs --plate <LICENSE_PLATE> --type <oto|xemay|xemaydien> [--phone <PHONE_NUMBER>]');
}

async function main() {
  const { plate, type, phone } = parseArgs(process.argv);
  const typeCode = mapType(type);
  if (!plate || !typeCode) {
    usage();
    process.exit(2);
  }

  const payload = {
    type: typeCode,
    bsx: normalizePlate(plate),
    sdt: phone || '0900000000',
  };

  const url = 'https://vnetraffic.org/wp-json/custom/v1/tra-cuu-csgt';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, status: res.status, statusText: res.statusText }, null, 2));
    process.exit(1);
  }

  const data = await res.json();

  const summary = {
    ok: true,
    source: 'vnetraffic.org (intermediate source, cross-check with official portals)',
    input: { plateRaw: plate, plateNormalized: payload.bsx, type, typeCode },
    updated_at: data.updated_at || null,
    code: data.code ?? null,
    message: data.message || null,
    totalViolations: data.totalViolations ?? 0,
    unhandledCount: data.unhandledCount ?? 0,
    handledCount: data.handledCount ?? 0,
    violations: data.violations ?? [],
    raw: data,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
```

---

## Description

This is an OpenClaw skill to look up traffic violations (fines) for vehicles in Vietnam.

### Installation & Usage

See the `SKILL.md` file for more details on running and interpreting lookup results.

### Publishing Info

To publish this skill to ClawHub:

```bash
clawhub publish . \
  --slug traffic-fine-lookup-vn \
  --name "Traffic Fine Lookup VN" \
  --version 1.0.0 \
  --changelog "Privacy remove"
```

---
name: traffic-fine-lookup-vn
description: Lookup traffic fines for vehicles in Vietnam. Use when the user asks to check traffic fines in VN by license plate (car/motorbike), especially via VNeTraffic-style lookup and CSGT cross-verification guidance.
---

# Lookup Vietnam Traffic Fines

Quick check using the VNeTraffic endpoint, then guide users to cross-confirm via official portals (CSGT/Registry) for formal verification.

## Quick lookup

Use the script:

```bash
node scripts/check_vnetraffic.mjs --plate <LICENSE_PLATE> --type <oto|xemay|xemaydien> [--phone <PHONE_NUMBER>]
```

Example:

```bash
node scripts/check_vnetraffic.mjs --plate 51K12345 --type oto
```

**License plate entry rules:**
- Always uppercase.
- Remove `-` and `.` before calling the API.
- Example: `51K-123.45` → `51K12345`.

## Interpreting Results

- If there are violations (`totalViolations > 0`):
  - Give a summary: total count, pending, processed.
  - List: time, location, status, authority, payment location.
- If no violations or no data found:
  - Clearly state no data found at the intermediary source.
  - Recommend cross-checking official portals.

## Reliability Warning

- `vnetraffic.org` is an **intermediate, non-government source**.
- Always clarify: Official conclusions should be cross-checked at:
  - https://www.csgt.vn (National Traffic Police Portal)
  - Vietnam Registry portals (when relevant)

## Fallback if automation not possible

If the endpoint errors, times out, or if an official portal requires CAPTCHA:
1. Ask the user for a screenshot of their search result.
2. Help interpret important result fields for the user.
3. Briefly explain next steps—no scare tactics, no speculation.