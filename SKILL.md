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
  console.error('Usage: node scripts/check_vnetraffic.mjs --plate <BIENSO> --type <oto|xemay|xemaydien> [--phone <SODT>]');
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

# Tra Cứu Phạt Nguội

Đây là một skill của OpenClaw dùng để tra cứu phạt nguội giao thông (ô tô, xe máy) tại Việt Nam.

## Cài đặt & Sử dụng

Xem file `SKILL.md` để biết thêm chi tiết về cách chạy và kiểm tra kết quả tra cứu.

## Thông tin Publish

Để publish skill này lên ClawHub, bạn có thể sử dụng lệnh sau:

```bash
clawhub publish . \
  --slug tra-cuu-phat-nguoi \
  --name "Tra Cuu Phat Nguoi" \
  --version 1.0.0 \
  --changelog "Privacy remove"
```
---
name: tra-cuu-phat-nguoi-vn
description: Tra cứu phạt nguội phương tiện tại Việt Nam. Use when user asks to check traffic fines in VN by license plate (ô tô/xe máy), especially via VNeTraffic-style lookup and CSGT cross-check guidance.
---

# Tra cứu phạt nguội VN

Tra cứu nhanh bằng endpoint của VNeTraffic, sau đó hướng dẫn đối chiếu nguồn chính thống (CSGT/Đăng kiểm) khi cần xác nhận.

## Chạy tra cứu nhanh

Dùng script:

```bash
node scripts/check_vnetraffic.mjs --plate <BIENSO> --type <oto|xemay|xemaydien> [--phone <SODT>]
```

Ví dụ:

```bash
node scripts/check_vnetraffic.mjs --plate 51K12345 --type oto
```

Quy tắc nhập biển số:
- Chuẩn hóa về chữ hoa.
- Bỏ dấu `-` và `.` trước khi gửi API.
- Ví dụ: `51K-123.45` -> `51K12345`.

## Diễn giải kết quả

- Nếu có lỗi vi phạm (`totalViolations > 0`):
  - Tóm tắt: tổng số lỗi, số chưa xử phạt, số đã xử phạt.
  - Liệt kê: thời gian, địa điểm, trạng thái, đơn vị xử lý, nơi nộp phạt.
- Nếu không có lỗi hoặc không có dữ liệu:
  - Báo rõ là chưa thấy dữ liệu trên nguồn tra cứu trung gian.
  - Khuyến nghị đối chiếu lại trên cổng chính thống.

## Cảnh báo độ tin cậy

- `vnetraffic.org` là nguồn trung gian, không phải cổng nhà nước chính thức.
- Luôn nói rõ: kết luận chính thức nên đối chiếu tại:
  - https://www.csgt.vn (Tra cứu phạt nguội)
  - Cổng tra cứu của Cục Đăng Kiểm (khi phù hợp)

## Fallback khi không thể tự động hóa

Nếu endpoint lỗi, timeout, hoặc trang chính thống yêu cầu CAPTCHA:
1. Xin user chụp màn hình kết quả tra cứu.
2. Đọc/diễn giải giúp user các trường quan trọng.
3. Nhắc bước xử lý tiếp theo ngắn gọn, không dọa, không suy diễn.
