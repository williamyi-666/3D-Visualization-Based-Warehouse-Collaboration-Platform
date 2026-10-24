# 3D可视化仓储协同平台

面向中小企业的仓储空间部署与协同作业平台。先建立仓库、货架和格位，再把货品关联到位置；电脑查看三维空间，手机办理现场业务，共用一套库存与流水。

维护者与版权署名：**零九贰幺**。本项目采用 [MIT 许可证](LICENSE)。第三方组件遵循各自许可证，许可原文及清单保存在 `third-party/`。本项目许可证不覆盖 Open supOS、Ollama、Qwen 及其他第三方软件、模型或素材。

## 核心能力

- 快速建仓：参数化货架、地面存放区、二维布局、门窗、格位合并和二维码标签。
- 首次建账：按实盘数量建立底账，缺少 SKU 时可生成临时编码，后续调整通过盘点留痕。
- 三维查询：按名称、SKU、格位码检索并定位；支持关联自有 Blender GLB 模型。
- 库存作业：入库、出库、移库、盘点复核、流水、导入导出和作业清单。
- 多端协同：电脑和手机浏览器共用服务；库存变动自动通知，正在编辑时延后刷新。
- SKU 容量：标准绑定 SKU、库存单位与格位尺寸；支持包装估算和现场核定，混放不计算总体满载率。
- 智能助手：可选接入 Ollama/Qwen，先生成预览，再由用户确认业务；基础仓储不依赖模型。
- 权限与备份：角色和仓库范围控制、变更审计、业务备份与恢复工具。

## 从源码启动

需要 Docker Engine/Desktop 和 Docker Compose v2；Windows 使用 Linux 容器。首次构建需要网络取得 Node 基础镜像和 npm 依赖；应用前端不依赖 CDN。

```bash
docker compose -f docker/compose.source.yml up -d --build
```

- 电脑：<http://localhost:38140/apps/web/prototype/index.html>
- 手机界面：<http://localhost:38140/apps/web/prototype/mobile.html>
- 首次在电脑页面创建管理员，没有预置账号密码；管理员再创建作业账号。
- 默认仅本机访问。局域网协同时设置 `SPATIAL_BIND_ADDRESS=0.0.0.0`，按环境开放对应端口，手机访问服务器局域网 IP 的同一路径。
- 实例名、端口和卷名通过 Compose 中的 `SPATIAL_*` 变量覆盖。不同项目使用不同名称和数据卷。
- 停止：`docker compose -f docker/compose.source.yml down`，保留数据卷；不要使用 `down -v` 删除业务数据。

手机使用网页，无需安装 APP。HTTP 支持查询和手工操作；摄像头扫码、拍照和可安装的离线网页能力需要受设备信任的 HTTPS。离线部署表示不依赖互联网，多端协同仍需能连接同一台服务器。

## Node.js 开发与测试

需要 Node.js 24。

```bash
npm ci
npm --prefix apps/api ci
npm --prefix apps/api start
# 默认 http://localhost:3000/apps/web/prototype/index.html
npm test
# 固定仿真场景的性能与业务测试
node tools/competition-benchmark.mjs --out output/benchmark
```

默认使用 SQLite、本地身份和独立库存。测试创建临时数据，不应指向已有业务数据目录。基准输出环境、原始样本、摘要 JSON 和 CSV；结果是仿真实测，不代表企业现场效率。真实手机、摄像头及 Wi-Fi 链路须单独验收。人工浏览器操作时间与后端处理时间不能混用。

## 部署与能力边界

- 独立库存由本应用维护数量；ERP 模式由外部系统提供库存，来源、映射、同步频率和盘点回写须按具体 ERP 接口联调。
- Open supOS 为可选集成，历史适配说明见 `docs/supos-integration.md`，不影响独立部署。
- Ollama 地址和模型名称由管理员配置；代码包不含模型权重及真实凭据。没有模型时仍可使用基础仓储。
- 包装估算需要尺寸资料；未登记叠放限制时仅估算单层。估算不能代替现场净空、承重及安全核定。
- 当前交付和测试使用 SQLite。PostgreSQL 文件为历史原型，不能仅切换环境变量就视为已受支持。
- 示例、录制和基准使用虚构数据，不包含客户库存；不同设备及企业接口需单独验收。

## Blender 仓库示例

`examples/warehouse/` 提供原创的 16 × 12 米剖切仓库：6 个货架、1 个地面存放区、76 个格位锚点，包含 `.blend`、`.glb`、布局参数与预览图。示例同样采用 MIT 许可证，不包含库存数据。

```bash
blender --background --python tools/blender/build_warehouse.py -- --layout examples/warehouse/layout.json --out output/warehouse --render
```

平台中的库区尺寸、货架位置和层列数须与 `layout.json` 一致。在“模型”中将 GLB 关联到已有库区，再切换“写实”视图；导入模型不会创建新库区或自动建立库存。格位点击与库存由平台管理。模型门窗为外观示例，未配置为业务布局中的门窗对象；修改布局后应同步重建模型。

## 代码结构

| 目录 | 内容 |
|---|---|
| `apps/api` | 身份、库存、空间、盘点、协同、助手与备份 |
| `apps/web/prototype` | 电脑三维界面、手机网页与业务表单 |
| `packages/three-kit` | 空间生成、布局、路径与 SKU 容量算法 |
| `packages/integration` | 外部系统适配与事件接口 |
| `tools` | 测试、基准、许可收集、部署与备份工具 |
| `third-party` | 第三方许可原文与清单 |
| `examples/warehouse` | Blender 仓库源文件、GLB、布局参数和预览 |

## 反馈与贡献

在仓库提交 Issue 时请写明版本、部署方式、复现步骤和脱敏截图。Pull Request 说明目的并运行相关测试。不要提交账号、令牌、真实库存、模型权重、数据库或上传附件。第三方署名与许可必须保留。

维护优先级：部署复现与业务正确性、多端体验、行业接口适配、按需接入智能助手。维护者统一评审变更和发布版本。

## 发布源码包

```bash
python tools/package-open-source.py --out releases/oa2026-source
```

打包使用明确目录清单，排除运行数据、历史材料、凭据、依赖安装目录和模型权重；保留原创仓库模型示例，输出源码 ZIP、逐文件哈希及版本信息。解压后的 `spatial-inventory/` 是可上传 GitHub/Gitee 的项目根目录。
