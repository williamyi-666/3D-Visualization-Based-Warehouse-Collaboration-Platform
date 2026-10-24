// packages/integration/index.mjs
// 集成层统一出口。
import { init, dispatchOnce, registerAdapter, integrationStatus } from './outbox.mjs';

export { init, dispatchOnce, registerAdapter, integrationStatus };
export * from './port.mjs';
export { importLayout } from './importers/index.mjs';
export { importLayoutPhoto, photoLayoutToTemplate } from './photoLayout.mjs';
