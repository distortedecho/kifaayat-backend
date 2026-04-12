// ============================================================
// Listener registration entry point (Phase 2.7)
//
// Imported from backend/src/index.ts at startup. Each listener
// group registers its handlers against the shared `appEvents`
// emitter in lib/events.ts.
// ============================================================

import { registerNotificationListeners } from "./notifications.js";
import { registerEmailListeners } from "./emails.js";
import { logger } from "../lib/logger.js";

let _registered = false;

export function registerAllListeners(): void {
  if (_registered) return;
  registerNotificationListeners();
  registerEmailListeners();
  _registered = true;
  logger.info("listeners.registered");
}

// Auto-register on import so the simple side-effect `import
// "./listeners/index.js"` in index.ts is enough.
registerAllListeners();
