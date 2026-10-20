# ⏱ `chronos-dev` v2.0 — Black-Box Flight Recorder & Time Machine for Code + Terminal

> **"Ủa, 15 phút trước code vẫn đang chạy ngon mà?!"**
> `chronos-dev` nối liền thế giới của **File Snapshot (Content-Addressable Storage)** và **Terminal Execution (`stdout`, `stderr`, `exit code`)** thành một dòng thời gian duy nhất, hoàn toàn tách biệt và tự động ẩn mình khỏi `.git` của bạn.

---

## ⚡ Cài đặt nhanh trong 5 giây (Zero-Dependency, siêu nhẹ ~24 KB)

### Cách 1: Cài đặt trực tiếp từ GitHub qua NPM (Dùng được ngay lập tức!)
```bash
npm install -g github:minKasent/chronos-dev
```
Sau khi cài xong, bạn có ngay lệnh `chronos` và bí danh siêu tốc **`ch`** ở mọi thư mục trên máy!

### Cách 2: Cài đặt 1 dòng lệnh (One-liner Installer)
* **Windows (PowerShell):**
  ```powershell
  irm https://raw.githubusercontent.com/minKasent/chronos-dev/main/install.ps1 | iex
  ```
* **macOS / Linux:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/minKasent/chronos-dev/main/install.sh | sh
  ```

### Cách 3: Chạy thử ngay không cần cài (`npx`)
```bash
npx github:minKasent/chronos-dev demo
```

---

## 🔥 Các tính năng "MAXPING" trong v2.0

1. **🕵️‍♂️ Auto-Bisect Bug Detective (`ch bisect <cmd>`):**
   - Khi bạn đã sửa qua hàng chục mốc mà chưa `git commit` và phát hiện test bị tạch, chỉ cần gõ `ch bisect node test.js`.
   - Công cụ tự động chạy **Tìm kiếm nhị phân (`O(log N)`)** qua các micro-checkpoint để chỉ đích danh **mốc đầu tiên gây ra lỗi** và in ra chính xác dòng code thủ phạm trong vài trăm mili-giây!
2. **✨ Surgical Single-File Restore (`ch pick <ref> <file...>`):**
   - Không cần tua ngược toàn bộ dự án! Nếu bạn sửa 5 file mà chỉ làm hỏng `src/pricing.js`, chỉ cần gõ `ch pick --last-green src/pricing.js` (hoặc bấm nút **"⏪ Restore Only This File"** trên Web UI) để nhặt đúng 1 file từ bản chạy xanh về hiện tại.
3. **🏷 Bookmark / Tag Mốc Quan Trọng (`ch tag <ref> <name>`):**
   - Đánh dấu bất kỳ mốc nào bằng tên dễ nhớ (VD: `ch tag --last-green v1-stable`), sau đó dùng `ch d v1-stable` hoặc `ch back v1-stable` mọi lúc (và `ch gc` sẽ không bao giờ xóa mốc đã gắn tag!).
4. **📋 Xuất Báo Cáo Lỗi Tự Động Che Secret (`ch export`):**
   - Tạo báo cáo Markdown đầy đủ gồm thông số môi trường, log lỗi `stdout`/`stderr`, và `diff` kể từ `--last-green` — đồng thời **tự động che (redact)** mật khẩu DB, JWT, Bearer Token, API Key!
5. **⚠️ Phát Hiện Trôi Dạt Môi Trường (Environment Drift Detector):**
   - Tự động cảnh báo nếu giữa lần chạy xanh trước đó và lần chạy lỗi hiện tại bạn đã đổi phiên bản Node.js, chuyển nhánh Git, hoặc sửa file `.env`.
6. **🟢 Giao Diện Web v2.0 Đồng Bộ Thời Gian Thực (Live SSE + Time-Capsule Explorer):**
   - Bất kỳ lệnh `ch r` nào bạn gõ dưới Terminal đều tự động đẩy (push) trực tiếp lên giao diện Web `http://localhost:4321` qua Server-Sent Events mà không cần F5!

---

## 🎮 Bảng lệnh siêu tốc với `ch`

| Lệnh tắt | Tương đương | Công dụng |
| :--- | :--- | :--- |
| **`ch r <lệnh>`** | `chronos run "<lệnh>"` | Chạy lệnh bất kỳ (VD: `ch r npm test`), ghi lại log + exit code & chụp snapshot code |
| **`ch d [ref]`** | `chronos diff --last-green` | So sánh code đang lỗi hiện tại với **lần gần nhất lệnh chạy thành công (`exit 0`)** |
| **`ch bisect <lệnh>`** | `chronos bisect "<lệnh>"` | Chạy tìm kiếm nhị phân tự động tìm ra mốc đầu tiên làm hỏng bài test |
| **`ch pick <ref> <file>`** | `chronos pick` | Khôi phục phẫu thuật **chỉ 1 (hoặc vài) file** từ mốc cũ mà không đụng tới các file khác |
| **`ch tag <ref> <tên>`** | `chronos tag` | Gắn nhãn đánh dấu cho một mốc (VD: `ch tag --last-green before-refactor`) |
| **`ch export`** | `chronos export` | Xuất báo cáo lỗi định dạng Markdown (đã tự động che các mật khẩu/token nhạy cảm) |
| **`ch back [ref]`** | `chronos rewind --last-green` | Tua ngược toàn bộ project về bản chạy xanh gần nhất (tự động tạo backup an toàn trước khi tua) |
| **`ch tl`** | `chronos timeline` | Xem bảng lịch sử các lần chạy (Xanh ✅ / Đỏ ❌), các tag & thống kê tiết kiệm dung lượng CAS |
| **`ch i [id]`** | `chronos inspect [id]` | Xem lại toàn bộ `stdout`/`stderr` và code diff của một mốc cụ thể (VD: `ch i 4`) |
| **`ch ui --open`** | `chronos ui --open` | Mở giao diện **Web Flight Recorder Dashboard v2.0** trực tiếp trên trình duyệt |
| **`ch gc [số_lượng]`** | `chronos gc 20` | Dọn dẹp các checkpoint cũ nhưng **luôn giữ lại `--last-green` và các mốc đã gắn tag** |

---

## 🧪 Chạy bộ kiểm thử tự động (8 Unit & Integration Suites)

```bash
npm test
```
