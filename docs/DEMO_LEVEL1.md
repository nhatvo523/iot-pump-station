# Demo Level 1 - 15 phút

## Chuẩn bị trước buổi demo

- Khởi động Docker Desktop và `docker compose up -d` trong thư mục dự án.
- Deploy hai flow Node-RED; chờ schema ready và dữ liệu lưu tối thiểu 30 phút thực.
- Mở Node-RED, TDengine Explorer và dashboard Grafana **cổng 3001**.
- Đưa simulator về normal; nếu vừa low-level trip, chờ bể hồi tới 60% và P01 chạy lại.
- Mở một PowerShell subscribe `plant/ps01/#`; cửa sổ thứ hai ở thư mục dự án để chạy lệnh.
- Xem trước `reports/level1-verification.json` sau kiểm thử, nếu có. Report không được commit.
- Để kiểm thử Grafana bằng script, nạp token qua biến môi trường `GRAFANA_API_TOKEN`; không chia sẻ màn hình có token.

## Phân bổ thời gian

| Phút | Nội dung | Bằng chứng cần thể hiện |
| --- | --- | --- |
| 0–2 | Kiến trúc và mô hình thiết bị | T01, P01/P02, LT01/PT01/FT01; bốn dịch vụ; cổng Grafana riêng |
| 2–4 | Telemetry và lưu trữ | MQTT JSON cập nhật 2 giây; một timestamp tạo ba sensor, hai pump, một station row; query lịch sử ≥30 phút |
| 4–7 | High pressure và hai threshold alarms | Áp suất tăng, flow giảm, level tăng; Grafana pressure >6 và level ≥85 cùng Firing; bấm normal, quan sát phục hồi |
| 7–9 | Pump fault và standby | P01 Fault, P02 chuyển Running sau khoảng chờ thực; áp suất/flow giảm; bấm normal |
| 9–12 | Low level và interlock | Inlet dừng; warning 20%, critical 10%, pump dừng; normal cấp nước và pump chỉ chạy lại khi đạt 60% |
| 12–14 | Ngắt database và phục hồi | Chạy script interruption; MQTT vẫn cập nhật; SQL tạm lỗi, rồi database và charts nhận dữ liệu mới |
| 14–15 | Tổng kết giới hạn và bàn giao | Chỉ rõ gap dữ liệu khi ngắt, chưa retry INSERT; giới thiệu exports/config và tài liệu |

Thời gian scenario phụ thuộc level ban đầu, nhiễu và tick. Nếu bể đang quá cao/thấp, có thể dùng reset **trước khi bắt đầu demo** để khởi tạo mức 60%; reset không xóa lịch sử. Sau demo luôn đưa về normal. Giữ cả hai cảnh báo Firing đủ một chu kỳ đánh giá 10 giây trước khi normal để dễ quan sát.

## Lệnh hỗ trợ

```powershell
docker compose ps
docker compose exec mosquitto mosquitto_sub -t "plant/ps01/#" -v
```

Trong cửa sổ khác:

```powershell
'{"scenario":"high_pressure"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"scenario":"normal"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"scenario":"pump_fault"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"scenario":"low_level"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
```

Query lịch sử và trạng thái:

```powershell
curl.exe -u root:taosdata -d "SELECT FIRST(ts), LAST(ts), COUNT(*) FROM iot_ps.ps01_lt01" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, asset, pump_state FROM iot_ps.pump_status ORDER BY ts DESC LIMIT 6" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, alarm_code, is_active FROM iot_ps.alarm_events ORDER BY ts DESC LIMIT 10" http://localhost:6041/rest/sql
```

Kiểm thử B6:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Level1.ps1 -TestInterruption -ReportPath .\reports\level1-verification.json
```

Khi TDengine tắt: Node-RED báo lỗi HTTP/SQL, Grafana tạm hiển thị số cũ theo timestamp hoặc lỗi truy vấn. Sau khi bật lại: timestamp tăng, lịch sử cũ vẫn có, charts nhận dữ liệu mới. Đếm lỗi cũ không tự về 0. Không nói rằng dữ liệu trong thời gian ngắt được phát lại: hiện chưa có tính năng đó.

## Checklist nghiệm thu

| Mục | Điều kiện đạt | Nơi kiểm tra |
| --- | --- | --- |
| B1 | Bốn dịch vụ chạy; cấu hình và bước khởi động được ghi lại | Compose + README |
| B2 | MQTT JSON hợp lệ, đúng asset/tag, timestamp UTC, cập nhật 2 giây | MQTT subscriber + payload mẫu |
| B3 | Normal và ba fault scenario; flow/status/alarm nhất quán, có phục hồi | Simulator + events + pump timeline |
| B4 | Truy vấn trả lịch sử ít nhất 30 phút thực | SQL FIRST/LAST/COUNT và script |
| B5 | Ba live metrics, pump status, trends đúng; hai cảnh báo được minh họa | Dashboard + Grafana alert rules |
| B6 | MQTT → SQL → charts; ngắt có chủ đích và dữ liệu mới tự tiếp tục sau phục hồi | Script interruption + Node-RED Debug + dashboard |

Hoàn tất checklist kỹ thuật không thay thế phần trình bày trực tiếp 15 phút và việc reviewer nghiệm thu. Technical summary 2–3 trang và báo cáo checkpoint được bàn giao riêng ngoài Git; Level 2/PlantOS là phần tùy chọn riêng.
