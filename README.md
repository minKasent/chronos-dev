# ⏱ `chronos-dev` v3.0 Studio — Flight Recorder & Time Machine for Code + Terminal

> **"Ủa, 15 phút trước code vẫn đang chạy ngon mà?!"**
> `chronos-dev` nối liền thế giới của **File Snapshot (Content-Addressable Storage)** và **Terminal Execution (`stdout`, `stderr`, `exit code`)** thành một dòng thời gian duy nhất, hoàn toàn tách biệt và tự động ẩn mình khỏi `.git` của bạn.

---

## ⚡ Cài đặt nhanh trong 5 giây (Zero-Dependency, siêu nhẹ ~26 KB)

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

## 🏆 Điểm nhấn v3.0 Studio Edition (Senior UI/UX & Developer Experience)

1. **⌨️ Keyboard-First Studio & Command Palette (`Ctrl+K` / `Cmd+K`):**
   - Lướt qua dòng thời gian bằng phím **`↑`/`↓`** hoặc **`J`/`K`** (chuẩn Vim) với tốc độ phản hồi 0ms.
   - Bấm **`Ctrl+K`** (hoặc `?`) để mở bảng điều khiển **Command Palette** kiểu Linear/Raycast; phím tắt nhanh **`G`** (Diff vs Last Green), **`S`** (Đổi chế độ Split/Unified Diff), **`B`** (Auto-Bisect), **`E`** (Copy Bug Report), **`/`** (Gõ lệnh nhanh).
2. **🔀 Dual-Mode Diff (Side-by-Side Split View + Intra-Line Character Highlighting):**
   - Chuyển đổi tức thì giữa **Split View (2 cột Trái/Phải song song)** và **Unified View**.
   - **Tô sáng từng ký tự thay đổi bên trong dòng (Intra-Line Diff)**: nhận diện ngay cả những lỗi sửa nhầm 1 ký tự (`>=` thành `>`) trên cả Web Studio lẫn Terminal CLI!
   - Có thanh **File Jump Bar** nhảy nhanh tới từng file, thu gọn/mở rộng (`Collapse/Expand All`), và xem **Lịch sử tiến hóa riêng của từng file (`📜 History`)**.
3. **🧭 Compare Bar Tường Minh & Cảnh Báo Dirty Worktree:**
   - Chọn đối chiếu tự do giữa **bất kỳ 2 mốc nào (`Base ➔ Target`)** hoặc với `💻 Live Working Tree`.
   - Tự động phát hiện và hiển thị huy hiệu cảnh báo nếu thư mục làm việc trên ổ cứng đang có file sửa dở chưa chụp snapshot.
4. **📊 Execution Pulse Sparkline & Bộ Lọc Đa Chiều:**
   - Biểu đồ xung nhịp (`Execution Pulse & Duration`) trên đầu cột Timeline giúp nhìn 1 giây biết chuỗi chạy Xanh/Đỏ và thời gian thực thi (`ms`), kèm bộ lọc `All` | `✅ Pass` | `❌ Fail` | `🏷 Tagged` và tìm kiếm theo tên file.
5. **↩ Actionable Undo Toast (Hoàn Tác 1-Click):**
   - Mọi thao tác `⏪ Rewind` hoặc `✨ Restore File` đều đi kèm nút **`[↩ Undo Rewind]`** ngay trên thông báo để quay lại trạng thái trước đó trong 1 cú nhấp chuột.
6. **🕵️‍♂️ Auto-Bisect (`ch bisect`) + 🩺 Storage Doctor (`ch doctor`) + 🔒 Secret Redactor (`ch export`):**
   - Tìm kiếm nhị phân `O(log N)` tự động chỉ đích danh mốc gây lỗi; kiểm tra toàn vẹn mật mã `SHA-256` của toàn bộ kho CAS; và tự động che mật khẩu DB/JWT/API Key khi xuất báo cáo lỗi.

---

## 🎮 Bảng lệnh siêu tốc với `ch`

| Lệnh tắt | Tương đương | Công dụng |
| :--- | :--- | :--- |
| **`ch r <lệnh>`** | `chronos run "<lệnh>"` | Chạy lệnh bất kỳ (VD: `ch r npm test`), ghi lại log + exit code & chụp snapshot code |
| **`ch d [ref]`** | `chronos diff --last-green` | So sánh code đang lỗi hiện tại với **`--last-green`** (tô sáng từng ký tự thay đổi) |
| **`ch bisect <lệnh>`** | `chronos bisect "<lệnh>"` | Chạy tìm kiếm nhị phân tự động tìm ra mốc đầu tiên làm hỏng bài test |
| **`ch pick <ref> <file>`** | `chronos pick` | Khôi phục phẫu thuật **chỉ 1 (hoặc vài) file** từ mốc cũ mà không đụng tới các file khác |
| **`ch history <file>`** | `chronos history <file>` | Xem toàn bộ lịch sử thay đổi của riêng 1 file qua các lần chạy |
| **`ch doctor`** | `chronos doctor` | Kiểm tra toàn vẹn `SHA-256` của toàn bộ CAS blobs, chế độ ẩn Git & trạng thái Worktree |
| **`ch tag <ref> <tên>`** | `chronos tag` | Gắn nhãn đánh dấu cho một mốc (VD: `ch tag --last-green v1-stable`) |
| **`ch export`** | `chronos export` | Xuất báo cáo lỗi định dạng Markdown (đã tự động che các mật khẩu/token nhạy cảm) |
| **`ch back [ref]`** | `chronos rewind --last-green` | Tua ngược toàn bộ project về bản chạy xanh gần nhất (tự động tạo backup an toàn trước khi tua) |
| **`ch tl`** | `chronos timeline` | Xem bảng lịch sử các lần chạy (Xanh ✅ / Đỏ ❌), các tag & thống kê tiết kiệm dung lượng CAS |
| **`ch ui --open`** | `chronos ui --open` | Mở giao diện **Chronos Studio v3.0 Web UI** trực tiếp trên trình duyệt |
| **`ch gc [số_lượng]`** | `chronos gc 20` | Dọn dẹp các checkpoint cũ nhưng **luôn giữ lại `--last-green` và các mốc đã gắn tag** |

---

## 🧪 Chạy bộ kiểm thử tự động (10 Unit & Integration Suites)

```bash
npm test
```
