# Open supOS 集成说明

本文件保留 Open supOS 适配路线与接口说明。独立部署和当前能力边界以[项目 README](../README.md)为准；具体平台版本和企业接口需要单独联调。

## 已实现范围

### 通用库存HTTP联调（尚未对接真实ERP）

正式名称为“3D可视化仓储协同平台”，主实例使用外部库存模式。目前尚无企业ERP接口，先使用本项目同步JSON验证接入。来源专用凭证由管理员在同步管理中创建，通过环境变量`SPATIAL_SYNC_TOKEN`提供，不写进JSON文件或命令参数。

```powershell
# 默认只检查基本格式，不发送；服务端仍会校验字段、映射和版本。
node tools/send-inventory.mjs --file snapshot.json
# 明确提交到应用根地址；使用原文件重试，不自动改版本或生成新消息ID。
node tools/send-inventory.mjs --file snapshot.json --url http://localhost:28088/warehouse --send
```

```json
{"source":"ERP联调","mode":"snapshot","version":1,"rows":[{"placement":"sku","warehouse_code":"WH","sku":"BEARING-6204","name":"深沟球轴承6204","qty":10,"unit":"套"}]}
```

示例先进入待分配库存；对应仓库存在且格位绑定该来源SKU后，展示自动归位。`source`必须与凭证绑定来源一致。全量快照替换该来源的全部库存，空`rows`清空该来源；不要只发送本次变化的行冒充全量。增量使用`mode=delta`、连续版本和固定`message_id`，对账使用`mode=reconcile`。工具支持四种现有模式，不负责ERP字段转换。首次使用应选择隔离联调实例和专用来源。

应用独立运行在 Node.js 容器中，通过平台网关嵌入。后端验证平台身份：管理员可维护空间，普通用户只读。集成模式的外部库存由 ERP/WMS 快照提供，禁止经本地出入库接口改写。

首版使用 SQLite 和独立数据卷。当前固定平台后端为 1.0.11-T19、前端为 1.0.11-T16；其他版本须重新联调。FREE 不在本轮适配范围。

## MQTT 出站的两种模式

| 配置 | 行为 | 确认含义 |
|---|---|---|
| 未配置 Broker 和模型别名 | 不启用 MQTT 出站 | 事件仍保留在本地 |
| 仅配置 SUPOS_MQTT_URL | 按库位主题映射发布 | Broker 的 QoS 1 确认 |
| 配置 Broker、SUPOS_UNS_EVENT_ALIAS 和 SUPOS_UNS_EVENT_PATH | 核对预建模型，再发布事件信封并读回 | 平台当前值中的事件 ID、类型、时间戳和完整内容一致 |

两种模式均使用 `retain=false`。发布成功不代表 ERP 已处理，也不代表平台持久化保存了事件。接收方仍需按事件 ID 去重。

库位模式使用[主题映射](../packages/integration/mapping/supos-uns.yaml)，例如 `WH-1-A-L01-B01` 映射到 `myfactory/wh/WH-1/rack/A/layer/L01/bin/B01/quantity`。`node_id` 是数据库主键，不能当作库位编码；缺失可靠库位的事件保持待发送。内部 `item_id` 不冒充 SKU。

UNS 模型模式使用[事件适配器](../packages/integration/adapters/suposEventAdapter.mjs)。模型需预先创建：`dataType=1`，业务字段为 `event_id`、`event_type`、`payload` 三个 STRING 字段，并明确 `maxLen`；平台自动生成 `timeStamp` 和 `quality`。适配器不会创建或修改模型，字段超长时拒绝发送。原始事件缺少库位时，信封也不会补造库位。

## 配置与启用

从[配置模板](../docker/supos.settings.example)复制独立配置，交付包使用 PowerShell 7 执行 `install.ps1 -SettingsFile <配置文件>`；源码部署使用 `tools/deploy-supos.ps1`。完整安装、网关注册与备份步骤见交付包 `INSTALL.txt`。

可选出站配置如下，默认留空。启用前先核对待发送事件及目标环境，避免将演示事件送入正式系统。

```dotenv
SUPOS_MQTT_URL=
SUPOS_MQTT_USER=
SUPOS_MQTT_PASS=
SUPOS_UNS_EVENT_ALIAS=
SUPOS_UNS_EVENT_PATH=
SUPOS_INTERNAL_API=http://backend:8080
```

内部模型 API 只在当前固定平台网络中验证过；不能把该内部地址和认证方式直接用于公网部署。

## 派发与恢复

服务启动时派发一轮；管理员也可通过 `POST /api/admin/sync` 触发。连接自动重连不等于定时派发，本说明不承诺后台定时补发。

只有所有已配置目标确认成功，事件才标记为 `sent`。dry-run、无目标、发送失败和模型读回不一致均不标记成功；失败保留重试次数与错误信息。历史 `sent` 不自动回放；没有证据的旧库位或历史 bulk 汇总不能无损恢复。保留原发件箱和备份，不以清空历史事件代替故障处理。

## 验证入口与限制

- `node tools/mqtt-smoke.mjs`：临时数据库、随机非保留主题，验证 Broker 收发与断线恢复。
- `node tools/uns-events-smoke.mjs --outbox`：需在平台网络内使用预建的专用联调模型，临时数据库生成 11 类业务事件，验证实际派发器和平台逐条读回。该工具目前在源码中，不能假定已包含于每个离线包。
- `GET /api/admin/integration`：管理员查看出站配置及连接状态；页面可见不替代接口权限验证。

已有 Linux 安装、备份恢复、版本升级与回退的验收记录。真实普通会话直接管理 API、真实 ERP/WMS、现场扫码设备、平台完整许可证履约及官方商店审核仍按推进计划逐项验收。应用离线试用包不包含 Open supOS 平台，也不等于官方已接受的上架包。
