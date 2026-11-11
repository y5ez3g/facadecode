<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Bộ điều phối đa agent cho VS Code.**

Chạy các CLI agent chính hãng, chỉnh sửa code và xem lại các thay đổi trong cùng một cửa sổ IDE. Sử dụng các tài khoản và gói đăng ký của riêng bạn, đồng thời để các agent cộng tác giữa các cửa sổ và máy tính.

[![Trang web: facadecode.com](https://img.shields.io/badge/Trang%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: cài đặt](https://img.shields.io/badge/VS%20Code%20Marketplace-c%C3%A0i%20%C4%91%E1%BA%B7t-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: cài đặt](https://img.shields.io/badge/Open%20VSX-c%C3%A0i%20%C4%91%E1%BA%B7t-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Bản phát hành: tải về IDE](https://img.shields.io/badge/B%E1%BA%A3n%20ph%C3%A1t%20h%C3%A0nh-t%E1%BA%A3i%20v%E1%BB%81%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Vấn đề: báo lỗi](https://img.shields.io/badge/V%E1%BA%A5n%20%C4%91%E1%BB%81-b%C3%A1o%20l%E1%BB%97i-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · **Tiếng Việt** · [Polski](../pl/README.md)

</div>

[![Xem bản demo 2 phút trên facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Cài đặt

```sh
code --install-extension facade.facadecode
```

Hoặc cài đặt **Facade Code** từ [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) hoặc [Open VSX](https://open-vsx.org/extension/facade/facadecode). Tiện ích chạy trên macOS (Apple silicon), Linux (x64) và Windows (x64).

Tiếp theo, hãy cài đặt và đăng nhập vào bất kỳ CLI agent được hỗ trợ nào mà bạn định sử dụng: Claude Code, Codex, Antigravity, Muse Code, OpenCode hoặc Pi. Facade Code khởi chạy từng CLI bằng tài khoản và gói đăng ký riêng của chính CLI đó.

> **Theo mặc định, các agent chạy mà không cần hỏi phê duyệt.** Với `yolo` được bật mặc định, các agent có thể thực thi lệnh và thay đổi tệp mà không cần hỏi trước. Hãy tắt tùy chọn này để khôi phục các câu hỏi phê duyệt tiêu chuẩn của từng CLI. Xem [README tiện ích](../../../extension/README.md#install).

## Agent Panel

**Các agent và IDE của bạn, trong cùng một cửa sổ.**

Facade Code chạy các CLI agent chính hãng (Claude Code, Codex, Antigravity, Muse Code, OpenCode và Pi) trong các tab terminal biên tập bên cạnh các tệp của bạn, sử dụng các lệnh, công cụ, tài khoản và gói đăng ký riêng của từng CLI. Một thẻ trong bảng điều khiển sẽ theo dõi trạng thái của từng agent.

- **Làm việc ngay cạnh mã nguồn.** Mỗi agent chạy trong tab terminal riêng ở khu vực soạn thảo. Việc đóng một tab chỉ ẩn nó đi trong khi agent vẫn tiếp tục chạy; bấm vào thẻ của nó để mở lại tab.
- **Theo dõi trạng thái giữa các agent.** Các thẻ hiển thị nội dung gần nhất được gửi tới từng agent và liệu nó đang làm việc, cần cấp quyền hay gặp lỗi, cùng phần chi tiết cho biết tiêu đề, thư mục và ai đã khởi chạy nó. Các agent vẫn tiếp tục chạy xuyên suốt quá trình tải lại cửa sổ và khởi động lại tiện ích.
- **Thư mục và worktree.** Chạy agent trong bất kỳ thư mục không gian làm việc nào hoặc tạo Git worktree nhanh chóng để tách biệt các thay đổi mã nguồn. Ghim một cuộc trò chuyện (Pin) để khôi phục khi bạn mở lại không gian làm việc, hoặc tiếp tục các phiên trước từ lịch sử.

## Agent Use

**Để các agent điều khiển các agent khác, giống hệt như bạn.**

Thông qua MCP và giao thức terminal, các agent có thể khởi chạy, dừng, tìm kiếm và nhắn tin cho các agent khác, đọc màn hình terminal của nhau, nhập văn bản và nhấn phím.

- **Khởi chạy và dừng agent.** Một agent có thể khởi chạy các agent khác bằng bất kỳ CLI nào trong số sáu CLI, trong bất kỳ thư mục hoặc worktree mới nào thuộc các cửa sổ Facade trên máy tính này, và giao cho chúng nhiệm vụ đầu tiên. Một yêu cầu thử lại có cùng ID yêu cầu (request ID) sẽ không bao giờ khởi chạy agent thứ hai trùng lặp.
- **Gửi tin nhắn.** Các agent trao đổi tin nhắn với nhau và có thể nhắn tin cho bạn. Facade dán toàn bộ tin nhắn một lần và gửi đi. Nếu văn bản chưa gửi hoặc câu hỏi prompt đang chắn dòng nhập, việc gửi sẽ chờ cho đến khi ô nhập sẵn sàng.
- **Điều khiển terminal.** Một agent có thể đọc màn hình của agent khác, nhập lệnh và nhấn phím để trả lời prompt hoặc hỗ trợ đồng đội đang bị kẹt. Khi một agent con chờ cấp quyền, câu trả lời hoặc đăng nhập quá 20 giây, agent đã khởi chạy nó sẽ nhận được thông báo.

## Agent Mesh

**Kết nối các agent giữa các cửa sổ, máy tính và địa điểm.**

Facade Code kết nối các agent trong các cửa sổ Facade trên máy tính này thành một mạng lưới duy nhất. Mở một cửa sổ [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) để mở rộng sự cộng tác đó sang một máy khác.

- **Giữa các cửa sổ.** Khi bật `yolo`, một agent có thể liên lạc với mọi agent trên các cửa sổ Facade ở máy tính này, cả cục bộ lẫn Remote - SSH. Khi tắt, một agent chỉ tiếp cận nhóm của chính nó: agent do bạn khởi chạy và các agent được tạo từ đó.
- **Mở rộng qua SSH.** Trong cửa sổ [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh), các agent chạy trực tiếp trên máy từ xa với đầy đủ công cụ, tệp và tài khoản ở đó. Các agent cục bộ có thể trực tiếp khởi chạy và gửi tin nhắn tới các agent trong cửa sổ Remote - SSH.
- **Điều phối từ điện thoại.** Kết nối ứng dụng di động Claude với một phiên Claude Code trên máy tính của bạn bằng [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). Phiên đó có thể điều phối các agent khác qua Facade và báo cáo tiến độ trở lại điện thoại của bạn.

<sub>Remote Control yêu cầu phiên bản Claude Code được hỗ trợ, gói đăng ký đủ điều kiện và đăng nhập với đầy đủ quyền hạn. Xem [các yêu cầu thiết lập](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Nhiều dự án. Một cửa sổ.**

Tổ chức các dự án, feature worktree và các đội agent trong một thanh không gian làm việc chuyên dụng. Chuyển đổi giữa các dự án cùng các tệp và terminal tương ứng, trong khi các agent vẫn tiếp tục làm việc ở chế độ nền.

Tải về bản xem trước IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Tất cả bản phát hành](https://github.com/y5ez3g/facadecode/releases)

IDE là một bản fork của VS Code, cài đặt độc lập bên cạnh trình soạn thảo hiện tại của bạn và không dùng chung gì với nó: cài đặt, tiện ích mở rộng và lệnh `facade` hoàn toàn tách biệt. Các tiện ích mở rộng đến từ [Open VSX](https://open-vsx.org); một vài tiện ích độc quyền của Microsoft như Remote Development và C/C++ chỉ chạy trên các bản dựng chính thức của Microsoft. Kiến trúc và tài liệu đặc tả nằm trong [`docs/ide/`](../../ide/).

## Xây dựng từ mã nguồn

- **Tiện ích mở rộng:** Cung cấp [`extension/AGENTS.md`](../../../extension/AGENTS.md) cho agent lập trình của bạn để xây dựng gói tiện ích.
- **IDE:** Cung cấp [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) cho agent lập trình của bạn để xây dựng ứng dụng.

Để biết các nguyên tắc đóng góp và quy tắc phân nhánh, hãy xem [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) và [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Phản hồi

- **Lỗi & ý tưởng:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), hoặc **Help > Report Issue** trong IDE.
- **Lỗ hổng bảo mật:** Vui lòng báo cáo riêng tư theo hướng dẫn trong [`SECURITY.md`](../../../SECURITY.md).

## Giấy phép

MIT, tương tự VS Code gốc. Xem [`LICENSE.txt`](../../../LICENSE.txt) để biết thông báo bản quyền của Microsoft và các tác giả đóng góp cho Facade Code.

<sub>Facade Code là một sản phẩm độc lập và không liên kết với, được xác nhận bởi, hoặc được tài trợ bởi các nhà cung cấp công cụ bên thứ ba được hiển thị. Tất cả các nhãn hiệu và logo của bên thứ ba đều thuộc về chủ sở hữu tương ứng.</sub>
