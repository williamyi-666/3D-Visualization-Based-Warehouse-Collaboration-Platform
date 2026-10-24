// apps/api/db/index.mjs
// 数据层选择器：默认 SQLite（node:sqlite，零守护进程），DB_DRIVER=pg 时切换到 PostgreSQL（db-pg.mjs）。
// 用法：在 server.mjs 中 `import * as db from './db/index.mjs'`，所有函数接口保持一致，无需改动业务代码。
import * as sqlite from '../db.mjs';

const driver = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
let api = sqlite;
if (driver === 'pg') {
  // 仅当显式选择 PG 时才加载 pg 驱动（需 `npm i pg` 且 PGURL 指向运行中的 PostgreSQL）
  const pgMod = await import('../db-pg.mjs');
  api = pgMod;
  console.log('[db] driver = postgres (PGURL=' + (process.env.PGURL || '(default)') + ')');
} else {
  console.log('[db] driver = sqlite (embedded, 无需 Docker)');
}

export const {
  quickBuildRacks,
  pageSpaceOperations, listSpaceOperations, getSpaceOperation,
  cloneRack, getScene, getCells, getLocationTree, createItem, createRack, addAlias, getAliases, addCellPhoto, removeCellPhoto, setCellMeta, setCellsMeta, getCellHistory,
  search, updateItem, deleteItem, importItems, listInventory, listMovements, setRoom,
  updateRack, setRackMerges, setRackCells, setCellNames, deleteRack, deleteRoom, getLayout, saveLayout, listRooms, listSites, createSite, createRoomNode,
  // 旧名别名（家具→货架改名前的函数名，保留以兼容既有集成脚本）
  createFurniture, updateFurniture, deleteFurniture, setFurnitureMerges,
  getCellItems, inbound, outbound, moveItem,
  erpOf, setItemErpCode, getItemByErp, getItemByCode, listItems, markMovementsSynced, syncErpStock,
  prepareOutboundPayload, emit, getPendingOutbox, markOutboxSent, markOutboxDead, markOutboxRetry, TENANT,
  // 企业级 P0：用户 / 会话 / 权限 / 审计
  logMovement, listAuditMovements, ROLES,
  countUsers, listUsers, getUserByUsername, getUserById, createUser, updateUser, touchLogin,
  createSession, getSessionUser, deleteSession, purgeExpiredSessions,
  // 服务凭证（机器令牌）
  createServiceToken, listServiceTokens, revokeServiceToken, getServiceTokenByRaw,
  // ERP 映射批量维护
  upsertErpMapping, importErpMappings,
  // 写实模型资源（Blender glTF/GLB，按 loc_code 关联）
  setNodeAsset, getNodeAsset, deleteNodeAsset, getSceneAssets,
} = api;
export default api;
