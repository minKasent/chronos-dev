# ⏱ `chronos-dev` — Black-Box Flight Recorder & Time Machine for Code + Terminal

> **"Ủa, 15 phút trước code vẫn đang chạy ngon mà?!"**
> `chronos-dev` nối liền thế giới của **File Snapshot (Content-Addressable Storage)** và **Terminal Execution (`stdout`, `stderr`, `exit code`)** thành một dòng thời gian duy nhất, hoàn toàn tách biệt và tự động ẩn mình khỏi `.git` của bạn.

---

## ⚡ Cài đặt nhanh trong 5 giây (Zero-Dependency, siêu nhẹ ~21 KB)

### Cách 1: Cài đặt trực tiếp từ GitHub qua NPM (Khuyên dùng — dùng được ngay lập tức!)
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

## 🎮 Cách sử dụng siêu tốc với lệnh tắt `ch`

Bạn không cần gõ lệnh dài hay bọc dấu ngoặc kép phức tạp. Chỉ cần dùng **`ch`**:

| Lệnh tắt | Tương đương | Công dụng |
| :--- | :--- | :--- |
| **`ch r <lệnh>`** | `chronos run "<lệnh>"` | Chạy lệnh bất kỳ (VD: `ch r npm test`, `ch r mvn test`), ghi lại log + exit code & chụp snapshot code |
| **`ch d`** | `chronos diff --last-green` | So sánh code đang lỗi hiện tại với **lần gần nhất lệnh chạy thành công (`exit 0`)** |
| **`ch back`** | `chronos rewind --last-green` | Tua ngược toàn bộ project về bản chạy xanh gần nhất (tự động tạo backup an toàn trước khi tua) |
| **`ch tl`** | `chronos timeline` | Xem bảng lịch sử các lần chạy (Xanh ✅ / Đỏ ❌) & thống kê tiết kiệm dung lượng CAS |
| **`ch i [id]`** | `chronos inspect [id]` | Xem lại toàn bộ `stdout`/`stderr` và code diff của một mốc cụ thể (VD: `ch i 4`) |
| **`ch ui --open`** | `chronos ui --open` | Mở giao diện **Web Flight Recorder Dashboard** trực tiếp trên trình duyệt |
| **`ch w --exec "<cmd>"`** | `chronos watch` | Tự động chụp micro-snapshot (và chạy test) mỗi khi bạn bấm `Ctrl + S` lưu file |
| **`ch gc [số_lượng]`** | `chronos gc 20` | Dọn dẹp các checkpoint cũ, giải phóng dung lượng nhưng **luôn giữ lại `--last-green`** |

---

## 🛡 Các cơ chế an toàn & tối ưu đã được kiểm thử

1. **Tàng hình với Git (`.git/info/exclude`):** Tự động thêm `.chronos/` vào `.git/info/exclude`, không bao giờ làm bẩn `git status` hay bắt bạn phải sửa `.gitignore` của dự án.
2. **An toàn với File Nhị Phân (Binary-safe):** Tự động phát hiện file ảnh, font, file thực thi để không làm hỏng encoding khi diff, đồng thời khôi phục chính xác từng byte khi `rewind`.
3. **Không bao giờ mất code khi tua ngược (`pre-rewind` backup):** Nếu bạn đang sửa dở code mà gõ `ch back`, công cụ sẽ tự chụp một bản `pre-rewind` trước khi quay về quá khứ.
4. **Dọn rác thông minh (`ch gc`):** Tự động xóa các blob mồ côi nhưng luôn bảo vệ mốc `--last-green`.

---

## 🧪 Chạy bộ kiểm thử tự động (Unit & Integration Tests)

```bash
npm test
```
