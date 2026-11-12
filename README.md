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
6. Khi cập nhật simulator, bấm **init state (once)** để nạp lại cấu hình và trạng thái ban đầu. Check response tăng `ok`; dùng **show stats** để xem `ok / fail / rejected / skipped`. Khi schema chưa sẵn sàng, `skipped` có thể tăng; sau khi sẵn sàng, nó phải ngừng tăng.

Các lần chạy sau giữ nguyên flows trong volume `nodered-data`. Không cần import lại nếu mã nguồn không thay đổi.

## MQTT và scenario

| Topic | Nội dung |
| --- | --- |
| `plant/ps01/telemetry` | Snapshot sensor, pump, scenario và alarm active mỗi 2 giây |
| `plant/ps01/events` | Alarm xuất hiện/kết thúc, chỉ khi trạng thái thay đổi |
| `plant/ps01/control` | Điều khiển scenario hoặc Run/Stop/Fault từng pump |

Xem bản tin trực tiếp:

```powershell
docker compose exec mosquitto mosquitto_sub -t "plant/ps01/#" -v
```

Chạy ở cửa sổ PowerShell khác để đổi scenario:

```powershell
'{"scenario":"pump_fault"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"scenario":"normal"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
```

Giá trị hợp lệ: `normal`, `pump_fault`, `high_pressure`, `low_level`, `reset`. Ba lỗi là các tác nhân độc lập: bấm các Inject node cùng tên để bật cộng dồn, không xóa lỗi khác. Gửi `{"scenario":"high_pressure","active":false}` để tắt riêng nghẹt; `active` phải là boolean, bỏ qua trường này có nghĩa là bật. `normal` xóa mọi tác nhân và trở về tự động; `reset` còn khởi tạo lại mức bể và trạng thái mô phỏng, không xóa database. Lệnh bật/tắt tác nhân thực sự thay đổi trạng thái sẽ thoát manual; lệnh lặp giữ nguyên chế độ.

Ví dụ bật cả ba rồi tắt riêng giảm đầu vào, gửi từng lệnh tới `plant/ps01/control`:

```json
{"scenario":"low_level"}
{"scenario":"high_pressure"}
{"scenario":"pump_fault"}
{"scenario":"low_level","active":false}
```

Telemetry giữ cấu trúc cũ để tương thích Ingest. Trường `scenario` chỉ tóm tắt tác nhân được bật gần nhất còn hiệu lực, không liệt kê đủ các tác nhân; nếu tắt tác nhân đó, ưu tiên tên còn bật theo pump_fault → high_pressure → low_level. Xem đầy đủ cờ `triggers` trong Debug `applied` hoặc flow context `sim.simulation.triggers`. Danh sách `alarms` vẫn phản ánh giá trị đo và trạng thái bơm, không phải danh sách tác nhân. Lịch sử database hiện chưa lưu riêng bộ cờ này.

| Scenario | Hành vi |
| --- | --- |
| normal | Xóa cả ba tác nhân, thoát manual, bỏ nghẹt; chọn P01 chạy/P02 dừng khi bảo vệ cho phép; level theo cân bằng vào/ra |
| pump_fault | P01 Fault; giữ P02 nếu đang chạy, nếu đang dừng thì chờ chạy dự phòng khi bảo vệ cho phép. Tắt riêng lỗi chỉ đưa P01 từ Fault sang Stopped, không tự bật P01 |
| high_pressure | Giữ trạng thái các bơm và tác nhân khác; blockage tăng làm áp tăng, flow giảm. P02 riêng lẻ không nhất thiết tạo alarm áp cao |
| low_level | Giảm inlet còn 25 m³/h, giữ bơm và độ nghẹt; mức tăng hay giảm tùy outlet. Warning ở 20% vẫn cho Run, critical ở 10% dừng bơm và khóa Run |

Bình thường inlet cố định **40 m³/h**, low_level **25 m³/h**, không có dao động đầu vào. Khi không nghẹt:

| Bơm chạy | Outlet | Level với inlet 40 |
| --- | --- | --- |
| Chỉ P01 | 40 m³/h | Giữ nguyên |
| Chỉ P02 | 25 m³/h | Tăng |
| Cả hai | 50 m³/h | Giảm |
| Không bơm nào | 0 | Tăng nếu còn nước vào |

**Bảo vệ 90% chỉ chống tràn:** giảm inlet nếu cần, không tăng inlet để bù theo outlet. Tại 90%, outlet=0 thì inlet=0; outlet=25 thì inlet được hạn chế còn 25; hai bơm ra 50 thì inlet tối đa 40 nên level vẫn giảm. LT01 có nhiễu đo nên có thể hơi trên 90 dù mức vật lý không vượt ngưỡng.

Normal không luôn làm level về 60: inlet 40/P01 outlet 40 đã ổn định thì level giữ nguyên kể cả đang ở 90; muốn giảm phải bật thêm P02, tổng outlet 50. Riêng sau trạng thái giữ mức do lỗi, normal giữ inlet phục hồi ở lưu lượng outlet trước đó; nếu nhỏ hơn outlet P01 thì level giảm về 60 rồi cấp lại 40. Sau LOW_LOW_LEVEL, interlock chặn Run cho tới khi mức vật lý đạt 60 và alarm rất thấp đã clear, kể cả giảm đầu vào vẫn bật. Khi auto, P01 khỏe tự chạy lại; nếu P01 Fault thì P02 dự phòng được xét theo timer. Khi manual phải ra lệnh Run. Nếu nguồn cấp vẫn 25 và P01 hút ra 40, mô hình có thể lặp chu kỳ xuống 10 → dừng → nạp 60 → chạy lại.

### Điều khiển riêng từng bơm

Sáu nút `P01/P02 run/stop/fault` gửi tới cùng node Apply scenario. Ví dụ qua MQTT:

```powershell
'{"pump":"P02","command":"run"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
'{"pump":"P01","command":"stop"}' | docker compose exec -T mosquitto mosquitto_pub -t plant/ps01/control -q 1 -l
```

- Lệnh bơm hợp lệ chuyển trạm sang manual: không tự bật standby, không đổi giảm đầu vào hay độ nghẹt. Stop/Run đều xóa Fault của bơm được chọn; với P01 đồng thời xóa cờ pump_fault. Fault P01 bật cờ này nhưng vẫn ở manual. Run phải qua bảo vệ; trường scenario tóm tắt có thể đổi theo các cờ còn bật.
- Khi tác nhân high_pressure bật, hai bơm vốn đang chạy được tiếp tục chạy. Sau khi Stop một bơm, không cho Run lại khi bơm kia còn chạy. Khi cả hai dừng, được chọn Run một bơm. Giới hạn duy trì dù scenario tóm tắt mang tên lỗi khác hoặc alarm áp suất đã clear; HIGH_PRESSURE còn active cũng chặn bật thêm bơm.
- Bật lại tác nhân đã bật hoặc tắt lại tác nhân đã tắt giữ nguyên trạng thái, kể cả manual, timer và độ nghẹt. Thay đổi tác nhân thoát manual nhưng không tự chuẩn hóa lại cả hai bơm; normal/reset vẫn có tác dụng khi bấm lại.
- LOW_LEVEL bật ở <=20%, clear >25%; LOW_LOW_LEVEL bật <=10%, clear >30%; HIGH_LEVEL bật >=85%, clear <=80%; HIGH_HIGH_LEVEL bật >=90%, clear <=85%; HIGH_PRESSURE bật >6 bar, clear <5,5 bar. PUMP_FAULT active khi ít nhất một bơm Fault.
- Các alarm/telemetry cập nhật ở tick tiếp theo; thao tác quá nhanh giữa hai tick có thể không xuất hiện thành trạng thái trung gian trong lịch sử.

Tick giữ 2 giây; mức bể và thời gian mô phỏng chạy x20, timestamp vẫn là giờ thực UTC. Lưu lượng và áp suất chuyển tiếp theo giây thực: hằng số thời gian tăng/giảm lưu lượng là 8/4 giây, áp suất là 8/6 giây; sau khi dừng bơm vẫn có dòng chảy dư ngắn trước khi về 0. Nghẹt tăng tới tối đa trong 60 giây thực. P02 chờ ít nhất 4 giây thực trong chế độ auto và được xét tại tick đầu tiên sau đó. Bể 20 m³; áp cơ sở P01/P02/cả hai là 4,2/2,625/5,17 bar. Nghẹt tối đa làm outlet P01/P02/cả hai còn 22/13,75/27,5 m³/h, áp tương ứng khoảng 6,3/3,94/7,755 bar trước nhiễu.

Payload mẫu: [telemetry](examples/telemetry.json), [event bật](examples/event.json), [event clear](examples/event-cleared.json), [danh mục lệnh](examples/control-commands.json). Xem [hướng dẫn examples](examples/README.md); đây là ví dụ tĩnh, không phát lại telemetry/event với timestamp cũ. Danh mục lệnh không phải một payload MQTT: chỉ gửi từng phần tử `payloads`.

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

Datasource `TDengine PS01` nối tới `http://tdengine:6041`, plugin chính thức được cố định ở 4.0.2. Dashboard có 12 panel: ba live metrics, ba trends, hai trạng thái bơm, timeline bơm, bảng event, danh sách Grafana alerts và thời điểm mẫu mới nhất. Hai panel Scenario/Simulator active alarms đã được bỏ; dữ liệu scenario vẫn được lưu trong station_state. Tự refresh mỗi 5 giây; mặc định chọn 30 phút gần nhất. Chọn khoảng thời gian cũ để xem lại lịch sử.

Sáu rule Grafana đánh giá mỗi 10 giây, không có thời gian Pending: **LOW_LEVEL**, **LOW_LOW_LEVEL**, **HIGH_LEVEL**, **HIGH_HIGH_LEVEL**, **HIGH_PRESSURE**, **PUMP_FAULT**. Rule đọc `station_state.active_alarms` từ mẫu mới nhất trong 30 giây để phản ánh trạng thái bật/xóa và hysteresis của simulator, tương ứng các mã trong `alarm_events`. Alert list chỉ hiện cảnh báo đang có vấn đề; rule đã về Normal được ẩn, còn bảng Alarm transitions giữ lịch sử bật/xóa. Scenario là chế độ mô phỏng, còn Normal/Firing là trạng thái của từng rule: chọn normal không xóa ngay alarm mức nước nếu bể chưa qua ngưỡng phục hồi. Chưa cấu hình email/Slack. Dữ liệu mất quá 30 giây sẽ làm rule không có dữ liệu hoặc lỗi datasource; xem timestamp mới nhất để phân biệt số cũ với dữ liệu đang cập nhật.

Các file trong `grafana/provisioning/` tự tạo datasource, dashboard và rule. Dashboard JSON được đọc lại theo polling 30 giây, phù hợp bind mount trên Windows. Chỉnh dashboard trên UI không tự cập nhật file trong repo; cần export/cập nhật JSON để giữ thay đổi qua lần provisioning tiếp theo.

## Kiểm thử và demo Level 1

Kiểm tra scenario offline, không cần container và không phát lệnh điều khiển hệ thống thật; cần Node.js:

```powershell
node .\scripts\Verify-Scenarios.js --report reports/scenario-verification.json
```

Bộ kiểm tra thực thi mã function simulator với clock giả, kiểm tra từng tick và đưa telemetry/event qua mã ingest thật nhưng không gửi SQL tới database. Có 24 nhóm kiểm tra, gồm cân bằng 40/40 giữ mức và bật thêm P02 để giảm level. Exit 1 nếu có FAIL. Không thay thế demo trực tiếp hay kiểm tra giao diện.

Kiểm tra hệ thống đang chạy sau khi hai flow đã deploy và có ít nhất **30 phút dữ liệu thực** (x20 không rút ngắn yêu cầu lịch sử này):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Level1.ps1 -ReportPath .\reports\level1-verification-current.json
```

Script mặc định chỉ kiểm tra: đối chiếu hash function đã deploy, MQTT → TDengine, schema/history, mọi panel dữ liệu và sáu rule Grafana. Không phát lệnh scenario. `ExecutionPolicy Bypass` chỉ áp dụng cho tiến trình này, không đổi policy hệ thống. Để kiểm tra Grafana, đặt `GRAFANA_API_TOKEN` với token service account có quyền đọc datasource/dashboard/alert rules và query datasource. Không đưa token vào Git; không có token thì các mục liên quan ghi SKIP. Xem [scripts/README.md](scripts/README.md) để biết phạm vi từng kiểm tra.

Lần kiểm tra ngày 11/11/2026: **24/24 nhóm offline PASS**; hệ thống chạy **11 PASS, 0 FAIL, 1 SKIP** (không chạy lại ngắt TDengine). Mã function đã deploy khớp repository. Đây là kết quả tại thời điểm kiểm tra, không tự xác nhận phiên bản sau này; báo cáo chứa timestamp và hash nguồn.

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
scripts/Verify-Scenarios.js         Kiểm tra scenario/ingest trong bộ nhớ
scripts/README.md                   Cách chạy và giới hạn kiểm tra
docs/DEMO_LEVEL1.md                 Kịch bản demo và checklist nghiệm thu
```

Báo cáo `.docx` có tên `Bao_cao_*.docx` và kết quả trong `reports/` được `.gitignore` loại trừ theo yêu cầu, không đưa vào commit. Chúng được bàn giao riêng. Named volumes giữ flows, database, Grafana qua lần tạo lại container; không dùng `docker compose down -v` nếu cần giữ dữ liệu.

Các image dịch vụ hiện dùng tag `latest` (Mosquitto dùng `2`); plugin Grafana đã pin 4.0.2. Khi cần tái hiện đúng bản đã kiểm thử, ghi lại image ID/digest bằng `docker image inspect` hoặc cố định tag/digest trước khi nâng cấp. Môi trường này là demo local với broker anonymous; chưa phải cấu hình production.
