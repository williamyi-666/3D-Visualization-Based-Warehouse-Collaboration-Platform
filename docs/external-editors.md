# 外部工具对接：布局文件导入能力

平台的空间由数据驱动生成器（`spaceGenerator` + LOC 编码）掌控，外部工具**只作尺寸/布局作者**，
导出的文件经解析器变成规范布局模板，再载入「布局编辑器」或直接保存进数据库。
**无需拥有任何商业软件即可验证**：仓库内含 `packages/integration/importers/sample-warehouse.dxf` 示例。

## 支持的文件格式

| 格式 | 来源工具 | 解析器 | 房间识别 | 家具识别 |
|---|---|---|---|---|
| `.dxf` | AutoCAD / 中望 / Rhino / SketchUp / FreeCAD / 任何 BIM 导出 DXF | `dxf.mjs` | 面积最大的闭合多段线 | 其余闭合多段线 / INSERT 块 |
| `.ifc` | Revit / ArchiCAD / BricsCAD BIM（导出 IFC） | `ifc.mjs`（STEP 子集） | `IfcSpace` 的 `IfcRectangleProfileDef` 足迹 | `IfcFurniture` / 名称含货架的 `IfcBuildingElementProxy` |
| `.json` | 平台自有「导出模板」 | — | 直接读取 | 直接读取 |

> 单位：DXF 优先读 `$INSUNITS` 自动换算米；IFC 本身就是米；JSON 原样。
> 坐标映射：DXF/IFC 的 (x, y) 平面 → 世界 (X, Z)；房间居中于原点。

## 使用方式（实时版）

1. 打开「布局」弹窗（布局编辑器）。
2. 点「导入模板」，选择 `.dxf` / `.ifc` / `.json` 文件。
3. 系统把文件 POST 到 `POST /api/import-layout`，服务端解析为规范模板并回显。
4. 在编辑器里微调位置/尺寸，**点「保存布局」**即写入数据库（已有家具按 code 更新，新家具自动创建并生成格位）。

## 各工具怎么导出

- **AutoCAD / 中望 / CAD**：画一个**闭合多段线**作房间外墙，再画若干**闭合矩形**或**插入块(INSERT)** 作货架/地面区 → 另存为 `DXF`（R12/LT2 文本格式最稳）。建议单位设为「米」。
- **SketchUp**：用矩形工具画房间与地面，导出 `DXF`（勾选 2D 剖面/平面）。
- **FreeCAD**：在 Draft/Part 工作台画轮廓，导出 `DXF`。
- **Revit / ArchiCAD（BIM）**：正常建模房间与家具 → 导出 `IFC2X3`（或 IFC4）。本解析器读取房间矩形足迹与家具摆放点。

## 解析器位置与扩展

- `packages/integration/importers/schema.mjs` —— 规范模板结构 + 校验（所有格式归一化到此）。
- `packages/integration/importers/dxf.mjs` —— DXF R12/2000 ASCII 解析。
- `packages/integration/importers/ifc.mjs` —— IFC STEP 子集（家具摆放 + 房间矩形足迹）。
- `packages/integration/importers/index.mjs` —— `importLayout(text, filename)`，按扩展名/内容嗅探路由。
- `apps/api/server.mjs` —— `POST /api/import-layout` 端点。
- `apps/api/db.mjs` —— `saveLayout` 已支持「新建缺失家具」（外部导入的新货架会自动建库位）。

### 想加新格式？
在 `importers/` 下新增 `xxx.mjs` 导出 `xxxToTemplate(text)`，再到 `importers/index.mjs` 的 `sniff()` 与分发分支注册即可。
视觉皮肤（C4D/Blender 的 GLB）走另一条路（`spaceGenerator` 的 GLB 外壳叠加），不进布局模板。

## 当前限制（诚实说明）
- **离线版（standalone）暂未接入**：离线版无服务端，DXF/IFC 需浏览器端解析，后续在 `standalone-app.js` 内联同一解析器即可（逻辑已就绪，仅打包差异）。
- **IFC 为子集**：复杂参数化墙、斜墙、非矩形房间、旋转家具暂未覆盖；房间尺寸依赖矩形足迹（多数 BIM 满足）。
- **家具尺寸/旋转**：DXF 由闭合多段线/块包围盒得出；IFC 家具尺寸未从几何读取（默认 1×1，可在编辑器改）。
