---
name: traffic-fine-lookup-vn
description: "Look up traffic fines for vehicles in Vietnam by license plate, summarize the result, and remind the user to cross-check official portals."
metadata: {"openclaw":{"emoji":"🚦","homepage":"https://www.csgt.vn","skillKey":"traffic-fine-lookup-vn","requires":{"config":["gateway.controlUi.enabled"]},"primaryEnv":"TRAFFIC_LOOKUP_REGION"}}
---

# Traffic Fine Lookup VN

Use this skill when the user asks to check traffic violations or unpaid traffic fines for a vehicle in Vietnam by license plate.

This skill uses `vnetraffic.org` as an intermediate lookup source and must always guide the user to verify important findings with official portals such as `https://www.csgt.vn`.

## Purpose

- Normalize Vietnamese license plates into the expected API input format.
- Query the VNeTraffic-style endpoint through the provided script.
- Summarize the result in a clear and non-alarmist way.
- Explain what the result means and what the user should verify next.

## When to Use

- The user asks to check traffic fines for a car, motorbike, or electric motorbike in Vietnam.
- The user provides a Vietnamese license plate and wants to know whether there are unresolved violations.
- The user needs help interpreting lookup results from an unofficial or intermediary source.

## When Not to Use

- The user wants a legally binding conclusion without checking official sources.
- The user asks for a violation lookup outside Vietnam.
- The user does not provide enough information to identify the vehicle type.

## Required Inputs

- `plate`: Vietnamese license plate.
- `type`: one of `oto`, `xemay`, or `xemaydien`.
- `phone` (optional): contact phone number required by the upstream endpoint. If not supplied, the script uses a placeholder.

## License Plate Rules

- Convert to uppercase.
- Remove spaces, hyphens, and dots before lookup.
- Example: `51K-123.45` becomes `51K12345`.

## Vehicle Type Mapping

- `oto` → `1`
- `xemay` → `2`
- `xemaydien` → `3`

## Script to Use

```bash
node scripts/check_vnetraffic.mjs --plate <LICENSE_PLATE> --type <oto|xemay|xemaydien> [--phone <PHONE_NUMBER>]
```

Example:

```bash
node scripts/check_vnetraffic.mjs --plate 51K12345 --type oto
```

## Expected Workflow

1. Confirm the plate and vehicle type.
2. Normalize the plate before lookup.
3. Run `scripts/check_vnetraffic.mjs` with the normalized values.
4. Read the returned JSON carefully.
5. Summarize:
   - total violations
   - unresolved count
   - resolved count
   - important violation details such as time, place, authority, and payment location
6. Clearly label the source as an intermediate source.
7. Recommend official verification if the result shows a violation or if the user needs formal confirmation.

## Output Format Guidance

When there are violations:

- State that the lookup found records.
- Summarize counts first.
- Present each violation in a compact list:
  - time
  - location
  - status
  - authority
  - payment or handling location

When there are no violations or no data:

- State that no data was found from the intermediate source.
- Avoid claiming that the vehicle is fully clear in a legal sense.
- Recommend checking the official portals if the user needs certainty.

## Reliability and Safety Notes

- `vnetraffic.org` is not an official government system.
- Treat the result as an operational hint, not a final legal conclusion.
- Always recommend cross-checking with:
  - `https://www.csgt.vn`
  - relevant Vietnam Registry channels when applicable
- Do not invent missing fields.
- Do not speculate about fines, penalties, or legal outcomes beyond the returned data.

## Fallback Handling

If the endpoint fails, times out, or returns incomplete data:

1. Tell the user the automated lookup could not be completed.
2. Ask the user for the search result screenshot if they already checked manually.
3. Help interpret the returned fields.
4. Suggest official verification steps.

## Script Reference

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

## Publishing Example

```bash
clawhub publish . \
  --slug traffic-fine-lookup-vn \
  --name "Traffic Fine Lookup VN" \
  --version 1.0.0 \
  --changelog "Initial published skill"
```