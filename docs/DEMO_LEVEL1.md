# Demo Level 1 - 15 phút

## Chuẩn bị trước buổi demo

- Khởi động Docker Desktop và `docker compose up -d` trong thư mục dự án.
- Deploy hai flow Node-RED; chờ schema ready và dữ liệu lưu tối thiểu 30 phút thực.
- Mở Node-RED, TDengine Explorer và dashboard Grafana **cổng 3001**.
- Sau khi import bản simulator mới, Deploy và bấm init state. Đưa về normal; để có điểm đầu nhất quán, dùng reset trước buổi demo (level 60, P01 chạy, P02 dừng). Normal với vào/ra 40/40 không tự đưa level hiện tại về 60.
- Mở một PowerShell subscribe `plant/ps01/#`; cửa sổ thứ hai ở thư mục dự án để chạy lệnh.
- Chạy kiểm tra offline và kết nối theo các lệnh bên dưới; xem `reports/scenario-verification.json` và `reports/level1-verification-current.json`. Report không được commit. Kết quả cũ không thay thế kiểm tra phiên bản đang demo.
- Để kiểm thử Grafana bằng script, nạp token qua biến môi trường `GRAFANA_API_TOKEN`; không chia sẻ màn hình có token.

## Phân bổ thời gian

| Phút | Nội dung | Bằng chứng cần thể hiện |
| --- | --- | --- |
| 0–2 | Kiến trúc và mô hình thiết bị | T01, P01/P02, LT01/PT01/FT01; bốn dịch vụ; cổng Grafana riêng |
| 2–4 | Telemetry và lưu trữ | MQTT JSON cập nhật 2 giây; một timestamp tạo ba sensor, hai pump, một station row; query lịch sử ≥30 phút |
| 4–7 | High pressure và hai cảnh báo | Bắt đầu chỉ P01 chạy: áp tăng >6, flow giảm về khoảng 22, level tăng ≥85; HIGH_PRESSURE và HIGH_LEVEL Firing; chờ đánh giá rồi normal, quan sát phục hồi |
| 7–9 | Pump fault và standby | P01 Fault, P02 chuyển Running sau khoảng chờ thực; áp suất/flow giảm; bấm normal |
| 9–12 | Low level và interlock | Inlet 25, P01 ra 40 nên level giảm; warning 20% vẫn cho Run, critical 10% dừng bơm; normal cấp 40 và pump chỉ tự chạy lại ở 60% khi auto |
| 12–14 | Ngắt database và phục hồi | Chạy script interruption; MQTT vẫn cập nhật; SQL tạm lỗi, rồi database và charts nhận dữ liệu mới |
| 14–15 | Tổng kết giới hạn và bàn giao | Chỉ rõ gap dữ liệu khi ngắt, chưa retry INSERT; giới thiệu exports/config và tài liệu |

Thời gian scenario phụ thuộc level ban đầu, nhiễu và tick. Tick 2 giây; mức bể chạy x20, còn áp suất, lưu lượng và độ nghẹt chuyển tiếp theo giây thực; timestamp giờ thực UTC. P02 chờ ít nhất 4 giây thực; nghẹt đạt tối đa sau 60 giây thực. Với chỉ P01 chạy ổn định trước lỗi, HIGH_PRESSURE bật khoảng 58 giây trong kiểm tra offline, chưa tính chu kỳ đánh giá Grafana. Lowlevel từ 60 xuống ngưỡng 10 mất khoảng 120 giây thực; nạp lại tới 60 bằng inlet 40 mất khoảng 45 giây, có ảnh hưởng của dòng chảy dư sau dừng. Nếu buổi demo đã chạy lệch lịch, chuẩn bị trước trạng thái đầu cho từng phần; không hứa mọi chuỗi thao tác hoàn tất chính xác theo từng phút. Reset không xóa lịch sử. Sau demo đưa về normal; nếu còn ở mức cao với cân bằng 40/40, bật thêm P02 để giảm rồi Stop P02 ở gần 60. Giữ cảnh báo Firing đủ một chu kỳ đánh giá 10 giây trước khi normal để dễ quan sát.

## Quy tắc cần giải thích khi demo

| Điều kiện | Hành vi cần thấy |
| --- | --- |
| Inlet bình thường 40, P01 outlet 40 | Level giữ nguyên, kể cả sau bấm normal ở mức 90 |
| Inlet 40, chỉ P02 outlet 25 | Level tăng |
| Inlet 40, cả hai outlet 50 | Level giảm; muốn giữ gần 60 thì Stop P02 khi đạt mức mong muốn |
| Lowlevel inlet 25, chỉ P02 outlet 25 | Level cân bằng; dùng P01 để minh họa level giảm |
| Bồn đạt 90 | Chỉ giảm inlet để chống tràn; không bù inlet lên 50 khi hai bơm hút ra 50 |
| Vào high_pressure khi cả hai đang chạy | Giữ cả hai chạy; khi nghẹt tối đa outlet khoảng 27,5, áp khoảng 7,755 |
| High pressure, Stop một bơm | Bơm kia tiếp tục chạy; Run lại bơm đã Stop bị từ chối trong scenario này |
| LOW_LEVEL / LOW_LOW_LEVEL | Warning vẫn cho Run; critical dừng bơm và khóa Run tới khi phục hồi 60, kể cả giảm đầu vào vẫn bật; manual không tự khởi động lại |
| Fault bằng tay | Không tự bật standby; Stop hoặc Run có thể xóa Fault của bơm đó |
| Bấm lại cùng scenario lỗi | Giữ nguyên trạng thái, kể cả manual; normal/reset vẫn có tác dụng |

Normal sau pump_fault/high_pressure có thể hạ level bằng inlet phục hồi đã giảm trước đó. Điều này khác trường hợp inlet/outlet đều 40, khi đó không có chênh lệch để level giảm. Alarm được cập nhật ở tick tiếp theo; Grafana đánh giá mỗi 10 giây và dashboard refresh mỗi 5 giây. Alarm mức nước vẫn còn là đúng nếu chưa qua ngưỡng clear, không coi bấm normal là xóa mọi alarm ngay lập tức.

Dashboard hiện có 12 panel; không còn panel Scenario/Simulator active alarms. Xem scenario trong MQTT hoặc query station_state. PS01 - Active alerts chỉ hiển thị trạng thái đang có vấn đề; bảng Alarm transitions giữ cả sự kiện bật và clear.

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

Các lệnh gửi lần lượt khi đến phần demo tương ứng, không chạy cả khối liên tiếp. Nếu muốn minh họa từng lỗi riêng, bấm normal hoặc reset trước mỗi lỗi: ba nút lỗi nay bật cộng dồn, không thay thế nhau. Lệnh bơm thủ công (cũng có sáu nút Inject):

```powershell
'{"pump":"P02","command":"run"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"pump":"P02","command":"stop"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"pump":"P01","command":"fault"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
```

Để minh họa giới hạn Run high_pressure: normal → Run P02 → high_pressure → xác nhận cả hai còn chạy → Stop P01 → Run P01 bị từ chối vì P02 vẫn chạy. Chờ một tick để quan sát từng trạng thái. Chuỗi này là phần mở rộng, không cần chạy chen vào phần high-pressure chuẩn đang dùng chỉ P01.

Demo kết hợp: reset → low_level → high_pressure → pump_fault. P01 lỗi, P02 chạy dự phòng nếu không bị khóa; khi ổn định, inlet 25, outlet 13,75 m³/h, áp khoảng 3,94 bar nên level tăng nhưng không nhất thiết có alarm áp cao. Trong lúc nghẹt tăng, mức bể có thể giảm trước rồi mới tăng. Xem các cờ tác nhân trong Debug applied; scenario MQTT chỉ là tên tóm tắt. Tắt riêng tác nhân qua MQTT:

```powershell
'{"scenario":"high_pressure","active":false}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
```

Thử chuyển tiếp: ở LOW_LEVEL bấm normal → high_pressure, P01 tiếp tục chạy và mức hồi theo cân bằng. Nếu đã LOW_LOW_LEVEL, hai bơm vẫn bị chặn tới 60%; sau đó auto cho P01 khỏe chạy qua đường nghẹt. Không bấm normal cũng có thể nhả khóa ở 60%: khi thiếu nước cấp vẫn bật và P01 chạy lại, mức có thể giảm đến lần dừng bảo vệ tiếp theo.

Query lịch sử và trạng thái:

```powershell
curl.exe -u root:taosdata -d "SELECT FIRST(ts), LAST(ts), COUNT(*) FROM iot_ps.ps01_lt01" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, asset, pump_state FROM iot_ps.pump_status ORDER BY ts DESC LIMIT 6" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, alarm_code, is_active FROM iot_ps.alarm_events ORDER BY ts DESC LIMIT 10" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, scenario, active_alarms FROM iot_ps.ps01_state ORDER BY ts DESC LIMIT 1" http://localhost:6041/rest/sql
```

Kiểm tra trước demo, không tác động scenario đang chạy:

```powershell
node .\scripts\Verify-Scenarios.js --report reports/scenario-verification.json
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Level1.ps1 -ReportPath .\reports\level1-verification-current.json
```

Offline dùng clock giả, kiểm tra vật lý/alarm và ingest không gửi SQL. Script live kiểm tra mã đã deploy khớp repo, MQTT → DB, các query dashboard và health sáu rule; không tự minh họa mọi alarm trên UI. Lần chạy 11/11/2026: offline 24 PASS; live 11 PASS, 1 SKIP do không ngắt TDengine. Chi tiết tại [scripts/README.md](../scripts/README.md).

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
