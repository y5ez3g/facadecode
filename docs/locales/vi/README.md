<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Chạy agent lập trình AI trên các máy của bạn.**

Facade Code chạy nhiều CLI lập trình AI trên các máy của bạn. Các agent có thể tìm nhau, nhắn tin, đọc màn hình và gõ trong terminal. Bạn có thể điều khiển chúng qua Shell, VS Code hoặc ứng dụng hỗ trợ MCP. Mỗi máy chạy Orchestrator riêng và kết nối qua SSH.

[![Trang web: facadecode.com](https://img.shields.io/badge/Trang%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: cài đặt](https://img.shields.io/badge/VS%20Code%20Marketplace-c%C3%A0i%20%C4%91%E1%BA%B7t-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: cài đặt](https://img.shields.io/badge/Open%20VSX-c%C3%A0i%20%C4%91%E1%BA%B7t-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Vấn đề: báo lỗi](https://img.shields.io/badge/V%E1%BA%A5n%20%C4%91%E1%BB%81-b%C3%A1o%20l%E1%BB%97i-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · **Tiếng Việt** · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Xem bản demo 2 phút trên facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Cài đặt

### Shell

Trình cài đặt một dòng có từ bản phát hành đầu tiên bao gồm các gói độc lập.
Gói Shell hỗ trợ macOS, Linux và Windows trên x64 và arm64.

Chạy lệnh này trên macOS hoặc Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

Trên Windows, chạy lệnh này trong PowerShell.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

Trình cài đặt thêm `facade` và `facade-mcp` vào PATH. Mở terminal mới để dùng PATH đã cập nhật. Chạy `facade upgrade` để cập nhật. Cài đặt và đăng nhập các CLI cần dùng trên từng máy. Các lựa chọn tích hợp gồm Claude Code, Codex, Antigravity, Muse Code, OpenCode và Pi.

Trình khởi chạy cũng có tên `facade`. Khi cài cả hai, Shell chạy chương trình xuất hiện trước trong PATH. Sau khi ngừng phát hành bản xem trước, tên lệnh thuộc về Orchestrator. Chạy `facade --version`. Dòng có dạng `facade <version>` xác nhận bạn đang dùng lệnh Shell.

### VS Code

```sh
code --install-extension facade.facadecode
```

Tiện ích có sẵn Orchestrator. Mở **Facade Code** trên thanh hoạt động rồi chọn **New Agent**, **Go to Agent** hoặc **Resume Agent**. Có gói macOS, Linux và Windows cho x64 và arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Thêm `facade-mcp` dưới dạng máy chủ MCP stdio. Ví dụ này dùng đối tượng `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Kết nối bên ngoài tham gia với vai trò Guest ở lần gọi công cụ đầu tiên. Sau khi gửi tin, dùng lệnh gọi `read_messages` mà `send_message` trả về để chờ hồi đáp.

## Làm việc trên nhiều máy

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Dùng địa chỉ do `facade list` hiển thị. Đăng ký máy khác bằng đích và tùy chọn SSH quen dùng. Để truy cập WSL hoặc Dev Container từ bên ngoài, hãy cấu hình SSH trong môi trường đó rồi đăng ký theo cùng cách. Bạn cũng có thể chạy Facade trực tiếp trong môi trường.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade cài phiên bản tương ứng trên máy từ xa khi cần. Facade dùng đường dẫn cài đặt cố định trên máy từ xa. Khi cài thủ công, hãy dùng cùng phiên bản với Orchestrator cục bộ. Trong VS Code, **Go to Agent** mở terminal của agent đang chạy. Không gian làm việc nhớ các agent đã mở, các agent hỗ trợ và Pin. Đóng thẻ terminal vẫn để agent chạy. **Resume Agent** và `facade resume` hiển thị công việc đã lưu.

> **YOLO được bật mặc định.** Agent bật YOLO có thể truy cập các agent khác trên máy đã kết nối. Đặt `"yolo": false` trong `facade.json` của máy đó để giữ cơ chế phê duyệt và sandbox của CLI, đồng thời giới hạn MCP trong cây tạo agent của bên gọi. Thiết lập có hiệu lực ở lần khởi chạy hoặc resume tiếp theo. `facade status` hiển thị đường dẫn tệp.

[Tài liệu sản phẩm (tiếng Anh)](../../PRODUCT.md) · [Bảng thuật ngữ](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Nhiều dự án. Một cửa sổ.**

Tổ chức các dự án, feature worktree và các đội agent trong một thanh không gian làm việc chuyên dụng. Chuyển đổi giữa các dự án cùng các tệp và terminal tương ứng, trong khi các agent vẫn tiếp tục làm việc ở chế độ nền.

Tải về bản xem trước IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Tất cả bản phát hành](https://github.com/y5ez3g/facadecode/releases)

Bản xem trước IDE cài song song với trình soạn thảo và dùng cài đặt, tiện ích riêng. Các tiện ích mở rộng đến từ [Open VSX](https://open-vsx.org); một vài tiện ích độc quyền của Microsoft như Remote Development và C/C++ chỉ chạy trên các bản dựng chính thức của Microsoft. Kiến trúc và tài liệu đặc tả nằm trong [`docs/ide/`](../../ide/).

## Xây dựng từ mã nguồn

- **Tiện ích mở rộng:** Cung cấp [`extension/AGENTS.md`](../../../extension/AGENTS.md) cho agent lập trình của bạn để xây dựng gói tiện ích.
- **Orchestrator / Shell.** [Hướng dẫn bản dựng](../../../core/README.md).
- **IDE:** Cung cấp [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) cho agent lập trình của bạn để xây dựng ứng dụng.

Để biết các nguyên tắc đóng góp và quy tắc phân nhánh, hãy xem [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) và [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Phản hồi

- **Lỗi & ý tưởng:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), hoặc **Help > Report Issue** trong IDE.
- **Lỗ hổng bảo mật:** Vui lòng báo cáo riêng tư theo hướng dẫn trong [`SECURITY.md`](../../../SECURITY.md).

## Giấy phép

MIT, tương tự VS Code gốc. Xem [`LICENSE.txt`](../../../LICENSE.txt) để biết thông báo bản quyền của Microsoft và các tác giả đóng góp cho Facade Code.

<sub>Facade Code là một sản phẩm độc lập và không liên kết với, được xác nhận bởi, hoặc được tài trợ bởi các nhà cung cấp công cụ bên thứ ba được hiển thị. Tất cả các nhãn hiệu và logo của bên thứ ba đều thuộc về chủ sở hữu tương ứng.</sub>
