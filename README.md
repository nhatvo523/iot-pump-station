# Industrial IoT - Pump Station (Level 1)

Mô phỏng trạm bơm PS01 và giám sát dữ liệu theo kiến trúc:

```text
Node-RED Simulator -> Mosquitto -> Node-RED Ingest -> TDengine -> Grafana
```

Mô hình gồm bể T01, pump chính P01, pump dự phòng P02 và ba sensor LT01 (%), PT01 (bar), FT01 (m³/h). Đây là mô hình minh họa logic, không yêu cầu chính xác thủy lực. Level 2 / PlantOS không thuộc phạm vi này.

## Khởi động trên Windows

Yêu cầu: Docker Desktop đang chạy với Linux containers và Docker Compose v2; PowerShell; trình duyệt. Lần chạy đầu cần Internet để tải image và plugin TDengine cho Grafana. Cần trống các cổng 1880, 1883, 6041, 6060 và 3001.

```powershell
cd C:\Users\LENOVO\iot-pump-station
docker compose config --quiet
docker compose up -d
docker compose ps
```

Grafana mới thuộc dự án, chạy tại cổng **3001** và dùng volume riêng. Container Grafana cũ ở cổng 3000 không thuộc Compose này.

| Dịch vụ | Địa chỉ | Vai trò |
| --- | --- | --- |
| Node-RED | http://localhost:1880 | Simulator và ingest |
| Mosquitto | localhost:1883 | MQTT broker |
| TDengine API | http://localhost:6041/rest/sql | Ghi/đọc bằng SQL qua HTTP |
| TDengine Explorer | http://localhost:6060 | Duyệt database, chạy SQL |
| Grafana | http://localhost:3001 | Dashboard và cảnh báo |

Kiểm tra API đã sẵn sàng trước khi import flow:

```powershell
curl.exe -u root:taosdata -d "SHOW DATABASES" http://localhost:6041/rest/sql
```

Mong đợi `code: 0`. Container `Up` chưa đồng nghĩa mọi thành phần đã sẵn sàng; TDengine có thể cần thêm thời gian khởi động.

## Import và deploy Node-RED

Flow trong repo là các file export; Compose **không tự import** chúng vào Node-RED.

1. Mở http://localhost:1880, chọn menu **Import -> select a file to import**.
2. Import `node-red/flows/simulator.json` và `node-red/flows/ingest.json`.
3. Nếu cập nhật flow đã có, dùng **Replace** cho các node trùng ID; tránh tạo bản sao các tab và MQTT client.
4. Bấm **Deploy**. Broker hostname trong flow là `mosquitto`, TDengine là `tdengine`; không thay bằng `localhost` trong container.
5. Sau 5 giây, ingest bắt đầu setup schema theo từng phản hồi. Chờ node Setup schema hiển thị **schema ready (4/4)**.
6. Check response tăng `ok`; dùng **show stats** để xem `ok / fail / rejected / skipped`. Khi schema chưa sẵn sàng, `skipped` có thể tăng; sau khi sẵn sàng, nó phải ngừng tăng.

Các lần chạy sau giữ nguyên flows trong volume `nodered-data`. Không cần import lại nếu mã nguồn không thay đổi.

## MQTT và scenario

| Topic | Nội dung |
| --- | --- |
| `plant/ps01/telemetry` | Snapshot sensor, pump, scenario và alarm active mỗi 2 giây |
| `plant/ps01/events` | Alarm xuất hiện/kết thúc, chỉ khi trạng thái thay đổi |
| `plant/ps01/control` | Điều khiển scenario mô phỏng |

Xem bản tin trực tiếp:

```powershell
docker compose exec mosquitto mosquitto_sub -t "plant/ps01/#" -v
```

Chạy ở cửa sổ PowerShell khác để đổi scenario:

```powershell
'{"scenario":"pump_fault"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"scenario":"normal"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
```

Giá trị hợp lệ: `normal`, `pump_fault`, `high_pressure`, `low_level`, `reset`. Có thể bấm các Inject node cùng tên trong simulator. `reset` khởi tạo lại trạng thái mô phỏng; không xóa database.

| Scenario | Hành vi |
| --- | --- |
| normal | P01 chạy, P02 dừng; áp suất/lưu lượng bình thường; level theo cân bằng vào/ra |
| pump_fault | P01 Fault; P02 chạy sau thời gian chờ; công suất nhỏ hơn làm áp suất/lưu lượng giảm, level tăng |
| high_pressure | Blockage tăng, áp suất tăng, lưu lượng giảm, level tăng |
| low_level | Inlet = 0; warning ở 20%, critical ở 10%; pump dừng và bị interlock |

Khi level đạt 90% trong pump_fault/high_pressure, điều tiết inlet giữ mức. Chuyển normal từ trạng thái giữ 90% sẽ hạ dần về 60% rồi khôi phục inlet bình thường. Sau low-level trip, chuyển normal cấp nước lại và chỉ cho pump chạy khi level đạt 60%.

Tick giữ 2 giây; động học chạy x20 nhưng timestamp vẫn là giờ thực UTC. P02 chờ ít nhất 2 giây thực và được xét tại tick đầu tiên sau đó, không phải callback đúng tuyệt đối 2 giây. Capacity minh họa: P01 40 m³/h; P02 25 m³/h; bể 20 m³.

Payload mẫu: [telemetry](examples/telemetry.json), [event](examples/event.json). Đây là ví dụ tĩnh; không phát lại trực tiếp để tránh ghi timestamp cũ.

## TDengine

Database `iot_ps`, precision milliseconds:

| Supertable | Một bản ghi chứa | Bảng con |
| --- | --- | --- |
| telemetry | `ts, val, qual` | Mỗi station/sensor; metadata: station, asset, tag_id, eng_unit |
| pump_status | `ts, pump_state, state_code` | Mỗi station/pump; metadata: station, asset, pump_role |
| station_state | `ts, scenario, active_alarms` | Mỗi station |
| alarm_events | `ts, severity, is_active, tag_id, val, thr` | Mỗi station/alarm code |

Pump code: Stopped = 0, Running = 1, Fault = 2. ISO UTC được chuyển thành epoch milliseconds. Một telemetry tạo **một INSERT nhiều bảng, sáu bản ghi**; một event tạo một INSERT/bản ghi. Metadata lấy từ registry; payload phải khớp. Function trả SQL trong `msg.payload`, hai Debug node cho phép xem chuỗi trước khi gửi.

Schema gốc nằm ở `tdengine/init.sql`; flow setup thực thi cùng năm DDL, sau đó `SHOW iot_ps.stables`. Retry tối đa 10 lần mỗi bước, backoff 2–5 giây. Có thể bấm **create schema** để chạy lại. `IF NOT EXISTS` không tự nâng cấp schema đã có.

Kiểm tra bằng PowerShell (không cần ở thư mục dự án khi chỉ dùng curl):

```powershell
curl.exe -u root:taosdata -d "SHOW iot_ps.stables" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, tag_id, val FROM iot_ps.telemetry ORDER BY ts DESC LIMIT 6" http://localhost:6041/rest/sql
curl.exe -u root:taosdata -d "SELECT ts, alarm_code, is_active FROM iot_ps.alarm_events ORDER BY ts DESC LIMIT 10" http://localhost:6041/rest/sql
```

TDengine có thể trả HTTP 200 cho SQL lỗi: luôn kiểm tra `code`. Các query khác nằm trong `tdengine/verify.sql`, chạy từng statement riêng qua REST. Database `log` là dữ liệu giám sát nội bộ TDengine.

## Grafana

Mở [PS01 Monitoring](http://localhost:3001/d/ps01-monitoring/ps01-pump-station-monitoring). Tài khoản lần đầu là `admin/admin`; lần sau dùng mật khẩu đã đổi. TDengine Explorer dùng tài khoản local demo `root/taosdata`. Cấu hình ingest hiện cũng sử dụng tài khoản demo này.

Datasource `TDengine PS01` nối tới `http://tdengine:6041`, plugin chính thức được cố định ở 4.0.2. Dashboard gồm ba live metrics, ba trends, trạng thái/timeline P01/P02, scenario, simulator alarms, bảng event, danh sách Grafana alerts và thời điểm mẫu mới nhất. Tự refresh mỗi 5 giây; mặc định chọn 30 phút gần nhất. Chọn khoảng thời gian cũ để xem lại lịch sử.

Hai rule Grafana đánh giá mỗi 10 giây: **LT01 ≥85%** và **PT01 >6 bar**, không có thời gian Pending. Chúng đánh giá độc lập với hysteresis cảnh báo của simulator. Chưa cấu hình email/Slack. Dữ liệu mất quá 30 giây sẽ làm rule không có dữ liệu hoặc lỗi datasource; xem timestamp mới nhất để phân biệt số cũ với dữ liệu đang cập nhật.

Các file trong `grafana/provisioning/` tự tạo datasource, dashboard và rule. Dashboard JSON được đọc lại theo polling 30 giây, phù hợp bind mount trên Windows. Chỉnh dashboard trên UI không tự cập nhật file trong repo; cần export/cập nhật JSON để giữ thay đổi qua lần provisioning tiếp theo.

## Kiểm thử và demo Level 1

Chạy sau khi hai flow đã deploy và có ít nhất **30 phút dữ liệu thực** (x20 không rút ngắn yêu cầu lịch sử này):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Level1.ps1
```

Script mặc định chỉ kiểm tra. `ExecutionPolicy Bypass` chỉ áp dụng cho tiến trình này, không đổi policy hệ thống. Để kiểm tra query qua Grafana, đặt `GRAFANA_API_TOKEN` trong môi trường tiến trình với token service account có quyền đọc datasource/dashboard. Không đưa token vào Git. Không có token thì script ghi rõ SKIP cho các kiểm tra query Grafana; vẫn cần kiểm tra UI.

Kiểm thử gián đoạn **sẽ dừng riêng TDengine 15 giây**, giữ MQTT và Node-RED chạy, rồi tự bật lại trong `finally`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Level1.ps1 -TestInterruption -ReportPath .\reports\level1-verification.json
```

Script kiểm tra MQTT vẫn phát trong lúc ngắt, SQL nhận mẫu mới sau khi khởi động lại, mẫu cũ còn nguyên và query Grafana có timestamp sau phục hồi (nếu có token). Mở thêm Grafana và Node-RED Debug để xem biểu đồ tạm ngừng cập nhật, lỗi ghi và dữ liệu tiếp tục sau đó. Không đóng cưỡng bức tiến trình khi đang kiểm thử. Nếu bị đóng, dùng `docker compose start tdengine` để khôi phục thủ công.

**Giới hạn đã xác định:** INSERT dữ liệu chưa có retry/hàng đợi bền vững. Bản tin trong thời gian database ngắt hoặc schema chưa sẵn sàng có thể mất và không được backfill. Phục hồi B6 nghĩa là dữ liệu mới tự tiếp tục sau khi nối lại, không phải bảo đảm không mất dữ liệu. `fail` giữ số lỗi đã xảy ra; sau phục hồi, nó phải ngừng tăng và `ok` tăng lại.

Kịch bản trình bày 15 phút và checklist B1–B6: [docs/DEMO_LEVEL1.md](docs/DEMO_LEVEL1.md).

## File và dữ liệu bàn giao

```text
docker-compose.yml                 Services và volumes
node-red/flows/simulator.json       Simulator export
node-red/flows/ingest.json          Ingest export
tdengine/init.sql                  Schema
tdengine/verify.sql                Query kiểm tra
grafana/dashboards/                 Dashboard export
grafana/provisioning/               Datasource/dashboard/alert config
examples/                          MQTT payload mẫu
scripts/Verify-Level1.ps1           Kiểm thử lặp lại, có tùy chọn ngắt kết nối
docs/DEMO_LEVEL1.md                 Kịch bản demo và checklist nghiệm thu
```

Báo cáo `.docx` có tên `Bao_cao_*.docx` và kết quả trong `reports/` được `.gitignore` loại trừ theo yêu cầu, không đưa vào commit. Chúng được bàn giao riêng. Named volumes giữ flows, database, Grafana qua lần tạo lại container; không dùng `docker compose down -v` nếu cần giữ dữ liệu.

Các image dịch vụ hiện dùng tag `latest` (Mosquitto dùng `2`); plugin Grafana đã pin 4.0.2. Khi cần tái hiện đúng bản đã kiểm thử, ghi lại image ID/digest bằng `docker image inspect` hoặc cố định tag/digest trước khi nâng cấp. Môi trường này là demo local với broker anonymous; chưa phải cấu hình production.
